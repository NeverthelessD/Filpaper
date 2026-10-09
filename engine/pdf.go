package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"strconv"
	"time"
)

const ptPerMM = 72.0 / 25.4

// Quality levels: 0 낮음, 1 보통, 2 높음, 3 매우 높음
var qualityDPI = [4]float64{100, 150, 220, 300}
var qualityJPEG = [4]int{55, 70, 82, 92}

type PageOptions struct {
	PaperW      float64 `json:"paperW"` // mm
	PaperH      float64 `json:"paperH"` // mm
	Orientation string  `json:"orientation"` // portrait | landscape | auto
	Margin      float64 `json:"margin"`      // mm
	Quality     int     `json:"quality"`
}

type rect struct{ X, Y, W, H float64 }

// pageGeometry returns the page size (pt) and where the image is drawn (PDF coords, origin bottom-left).
// The image keeps its aspect ratio and is scaled up or down to fit inside the margins.
func pageGeometry(e *ImageEntry, o PageOptions) (pw, ph float64, d rect) {
	short := math.Min(o.PaperW, o.PaperH)
	long := math.Max(o.PaperW, o.PaperH)
	if short <= 0 {
		short, long = 210, 297
	}
	landscape := false
	switch o.Orientation {
	case "landscape":
		landscape = true
	case "auto":
		landscape = e.Width > e.Height
	}
	if landscape {
		pw, ph = long*ptPerMM, short*ptPerMM
	} else {
		pw, ph = short*ptPerMM, long*ptPerMM
	}
	m := math.Max(0, math.Min(o.Margin*ptPerMM, math.Min(pw, ph)/2-1))
	aw, ah := pw-2*m, ph-2*m
	s := math.Min(aw/float64(e.Width), ah/float64(e.Height))
	dw, dh := float64(e.Width)*s, float64(e.Height)*s
	d = rect{X: m + (aw-dw)/2, Y: m + (ah-dh)/2, W: dw, H: dh}
	return
}

// targetMaxSide: longest displayed side (px) needed for the draw rect at the given DPI, never above original.
func targetMaxSide(e *ImageEntry, d rect, dpi float64) int {
	needW := d.W / 72 * dpi
	needH := d.H / 72 * dpi
	s := math.Min(1, math.Max(needW/float64(e.Width), needH/float64(e.Height)))
	longest := math.Max(float64(e.Width), float64(e.Height))
	return max(16, int(math.Ceil(longest*s)))
}

type pageImage struct {
	data  []byte
	w, h  int
	gray  bool
	pw    float64
	ph    float64
	draw  rect
}

// preparePage produces the optimized JPEG for one page.
func preparePage(e *ImageEntry, o PageOptions) (*pageImage, error) {
	q := clampQ(o.Quality)
	pw, ph, d := pageGeometry(e, o)
	maxSide := targetMaxSide(e, d, qualityDPI[q])
	img, err := loadScaled(e, maxSide)
	if err != nil {
		return nil, fmt.Errorf("‘%s’ 파일을 읽을 수 없어요", e.Name)
	}
	data, gray, err := encodeJPEG(img, qualityJPEG[q], true)
	if err != nil {
		return nil, err
	}
	p := &pageImage{data: data, w: img.Rect.Dx(), h: img.Rect.Dy(), gray: gray, pw: pw, ph: ph, draw: d}
	// 원본이 이미 더 작은 JPEG라면(축소 불필요·회전 없음·RGB) 재압축하지 않고 그대로 사용
	if e.format == "jpeg" && e.decodePath == e.path && e.orientation == 1 && !e.cmyk &&
		maxSide >= max(e.Width, e.Height) && e.Size > 0 && e.Size < int64(len(data)) {
		if orig, err := os.ReadFile(e.path); err == nil {
			if cfg, _, err := decodeConfigBytes(orig); err == nil && cfg.Width == e.rawW && cfg.Height == e.rawH {
				p.data, p.w, p.h = orig, e.rawW, e.rawH
				p.gray = isGrayModel(cfg)
			}
		}
	}
	return p, nil
}

func clampQ(q int) int {
	if q < 0 {
		return 0
	}
	if q > 3 {
		return 3
	}
	return q
}

// ---------------------------------------------------------------- minimal PDF writer

type pdfWriter struct {
	f       *os.File
	w       *bufio.Writer
	pos     int64
	offsets map[int]int64
	maxObj  int
}

func newPDFWriter(path string) (*pdfWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	p := &pdfWriter{f: f, w: bufio.NewWriterSize(f, 1<<20), offsets: map[int]int64{}}
	p.write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	return p, nil
}

func (p *pdfWriter) write(s string) {
	n, _ := p.w.WriteString(s)
	p.pos += int64(n)
}

func (p *pdfWriter) writeBytes(b []byte) {
	n, _ := p.w.Write(b)
	p.pos += int64(n)
}

func (p *pdfWriter) begin(n int) {
	p.offsets[n] = p.pos
	if n > p.maxObj {
		p.maxObj = n
	}
	p.write(strconv.Itoa(n) + " 0 obj\n")
}

func (p *pdfWriter) end() { p.write("\nendobj\n") }

func ff(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

// object numbers: 1 catalog, 2 pages, 3 info, then 3 per page.
func (p *pdfWriter) addPage(i int, pg *pageImage) {
	imgN, contN, pageN := 4+i*3, 5+i*3, 6+i*3
	cs := "/DeviceRGB"
	if pg.gray {
		cs = "/DeviceGray"
	}
	p.begin(imgN)
	p.write(fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n",
		pg.w, pg.h, cs, len(pg.data)))
	p.writeBytes(pg.data)
	p.write("\nendstream")
	p.end()

	content := fmt.Sprintf("q %s 0 0 %s %s %s cm /Im0 Do Q", ff(pg.draw.W), ff(pg.draw.H), ff(pg.draw.X), ff(pg.draw.Y))
	p.begin(contN)
	p.write(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	p.end()

	p.begin(pageN)
	p.write(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Resources << /XObject << /Im0 %d 0 R >> /ProcSet [/PDF /ImageB /ImageC] >> /Contents %d 0 R >>",
		ff(pg.pw), ff(pg.ph), imgN, contN))
	p.end()
}

func (p *pdfWriter) finish(pages int, title string) error {
	kids := make([]byte, 0, pages*10)
	for i := 0; i < pages; i++ {
		kids = append(kids, []byte(strconv.Itoa(6+i*3)+" 0 R ")...)
	}
	p.begin(2)
	p.write(fmt.Sprintf("<< /Type /Pages /Count %d /Kids [%s] >>", pages, string(kids)))
	p.end()
	p.begin(1)
	p.write("<< /Type /Catalog /Pages 2 0 R >>")
	p.end()
	p.begin(3)
	now := time.Now().Format("20060102150405")
	p.write(fmt.Sprintf("<< /Producer (Flipaper) /Creator (Flipaper) /Title %s /CreationDate (D:%s) >>", pdfTextString(title), now))
	p.end()

	xref := p.pos
	size := p.maxObj + 1
	p.write(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", size))
	for n := 1; n < size; n++ {
		if off, ok := p.offsets[n]; ok {
			p.write(fmt.Sprintf("%010d 00000 n \n", off))
		} else {
			p.write("0000000000 65535 f \n")
		}
	}
	p.write(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R /Info 3 0 R >>\nstartxref\n%d\n%%%%EOF\n", size, xref))
	if err := p.w.Flush(); err != nil {
		p.f.Close()
		return err
	}
	return p.f.Close()
}

func (p *pdfWriter) abort() {
	p.f.Close()
	os.Remove(p.f.Name())
}

// pdfTextString encodes a title as UTF-16BE hex string (Korean-safe).
func pdfTextString(s string) string {
	out := []byte("<FEFF")
	for _, r := range s {
		if r > 0xFFFF {
			r -= 0x10000
			hi, lo := 0xD800+(r>>10), 0xDC00+(r&0x3FF)
			out = append(out, []byte(fmt.Sprintf("%04X%04X", hi, lo))...)
		} else {
			out = append(out, []byte(fmt.Sprintf("%04X", r))...)
		}
	}
	return string(append(out, '>'))
}

var errCanceled = errors.New("canceled")

// writePDF renders the images into one PDF. Pages are prepared in parallel and written in order.
func writePDF(ctx context.Context, items []*ImageEntry, o PageOptions, path, title string, progress func(done int)) error {
	if len(items) == 0 {
		return errors.New("변환할 이미지가 없어요")
	}
	pw, err := newPDFWriter(path)
	if err != nil {
		return fmt.Errorf("파일을 만들 수 없어요: %v", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	workers := max(1, min(runtime.NumCPU(), 6))
	type result struct {
		pg  *pageImage
		err error
	}
	slots := make([]chan result, len(items))
	for i := range slots {
		slots[i] = make(chan result, 1)
	}
	sem := make(chan struct{}, workers*2)
	go func() {
		for i, e := range items {
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			go func(i int, e *ImageEntry) {
				if ctx.Err() != nil {
					slots[i] <- result{err: errCanceled}
					return
				}
				pg, err := preparePage(e, o)
				slots[i] <- result{pg, err}
			}(i, e)
		}
	}()
	for i := range items {
		var r result
		select {
		case r = <-slots[i]:
		case <-ctx.Done():
			pw.abort()
			return errCanceled
		}
		<-sem
		if r.err != nil {
			pw.abort()
			return r.err
		}
		pw.addPage(i, r.pg)
		if progress != nil {
			progress(i + 1)
		}
	}
	if ctx.Err() != nil {
		pw.abort()
		return errCanceled
	}
	if err := pw.finish(len(items), title); err != nil {
		os.Remove(path)
		return err
	}
	return nil
}

// estimateSizes predicts the PDF size for each quality level by really encoding up to 3 sample images.
func estimateSizes(items []*ImageEntry, o PageOptions) []int64 {
	res := make([]int64, 4)
	if len(items) == 0 {
		return res
	}
	n := min(3, len(items))
	idx := map[int]bool{}
	for i := 0; i < n; i++ {
		if n == 1 {
			idx[0] = true
		} else {
			idx[i*(len(items)-1)/(n-1)] = true
		}
	}
	sums := make([]float64, 4)
	counted := 0
	for i := range idx {
		e := items[i]
		_, _, d := pageGeometry(e, o)
		big, err := loadScaled(e, targetMaxSide(e, d, qualityDPI[3]))
		if err != nil {
			continue
		}
		counted++
		for q := 0; q < 4; q++ {
			side := targetMaxSide(e, d, qualityDPI[q])
			img := big
			if bl := max(big.Rect.Dx(), big.Rect.Dy()); side < bl {
				img = resizeRGBA(big, side)
			}
			data, _, err := encodeJPEG(img, qualityJPEG[q], true)
			if err == nil {
				size := float64(len(data))
				if e.format == "jpeg" && e.orientation == 1 && !e.cmyk && e.decodePath == e.path &&
					side >= max(e.Width, e.Height) && float64(e.Size) < size {
					size = float64(e.Size)
				}
				sums[q] += size
			}
		}
	}
	if counted == 0 {
		return res
	}
	for q := 0; q < 4; q++ {
		res[q] = int64(sums[q]/float64(counted)*float64(len(items))) + int64(len(items)*600+1200)
	}
	return res
}
