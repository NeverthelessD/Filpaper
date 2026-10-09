package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// ImageEntry is one uploaded image.
type ImageEntry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Width  int    `json:"width"`  // as displayed (EXIF orientation applied)
	Height int    `json:"height"` // as displayed

	path        string // uploaded original
	decodePath  string // file we can decode (original, or a JPEG converted with sips)
	format      string // jpeg, png, gif, webp, bmp, tiff
	orientation int    // EXIF 1..8
	rawW, rawH  int    // stored pixel size (before orientation)
	cmyk        bool
}

var errUnsupported = errors.New("unsupported image")

// analyzeImage inspects an uploaded file. HEIC & friends are converted with macOS `sips`.
func analyzeImage(e *ImageEntry, workDir string) error {
	e.decodePath = e.path
	cfg, format, err := decodeConfigFile(e.path)
	if err != nil {
		if runtime.GOOS != "darwin" {
			return errUnsupported
		}
		conv := filepath.Join(workDir, e.ID+"-conv.jpg")
		cmd := exec.Command("/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "95", e.path, "--out", conv)
		if out, err2 := cmd.CombinedOutput(); err2 != nil {
			_ = out
			return errUnsupported
		}
		e.decodePath = conv
		cfg, format, err = decodeConfigFile(conv)
		if err != nil {
			return errUnsupported
		}
	}
	e.format = format
	e.rawW, e.rawH = cfg.Width, cfg.Height
	if e.rawW <= 0 || e.rawH <= 0 {
		return errUnsupported
	}
	e.orientation = 1
	if format == "jpeg" {
		e.orientation = jpegOrientation(e.decodePath)
		if cfg.ColorModel == color.CMYKModel {
			e.cmyk = true
		}
	}
	if e.orientation >= 5 {
		e.Width, e.Height = e.rawH, e.rawW
	} else {
		e.Width, e.Height = e.rawW, e.rawH
	}
	return nil
}

func decodeConfigFile(path string) (image.Config, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return image.Config{}, "", err
	}
	defer f.Close()
	return image.DecodeConfig(bufio.NewReader(f))
}

// jpegOrientation reads the EXIF orientation tag (1..8) from a JPEG file.
func jpegOrientation(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	r := bufio.NewReader(f)
	var soi [2]byte
	if _, err := io.ReadFull(r, soi[:]); err != nil || soi[0] != 0xFF || soi[1] != 0xD8 {
		return 1
	}
	for {
		var m [2]byte
		if _, err := io.ReadFull(r, m[:]); err != nil || m[0] != 0xFF {
			return 1
		}
		marker := m[1]
		if marker == 0xD9 || marker == 0xDA { // EOI / SOS
			return 1
		}
		if marker >= 0xD0 && marker <= 0xD7 || marker == 0x01 {
			continue
		}
		var lb [2]byte
		if _, err := io.ReadFull(r, lb[:]); err != nil {
			return 1
		}
		n := int(binary.BigEndian.Uint16(lb[:])) - 2
		if n < 0 {
			return 1
		}
		seg := make([]byte, n)
		if _, err := io.ReadFull(r, seg); err != nil {
			return 1
		}
		if marker == 0xE1 && len(seg) > 14 && bytes.Equal(seg[:6], []byte("Exif\x00\x00")) {
			if o := exifOrientation(seg[6:]); o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
	}
}

func exifOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:8]))
	if off+2 > len(t) {
		return 1
	}
	count := int(bo.Uint16(t[off : off+2]))
	for i := 0; i < count; i++ {
		p := off + 2 + i*12
		if p+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[p:p+2]) == 0x0112 {
			return int(bo.Uint16(t[p+8 : p+10]))
		}
	}
	return 1
}

// loadScaled decodes the image, scales it so the *displayed* longest side is at most maxSide
// (never upscales), applies EXIF orientation and flattens transparency onto white.
func loadScaled(e *ImageEntry, maxSide int) (*image.RGBA, error) {
	f, err := os.Open(e.decodePath)
	if err != nil {
		return nil, err
	}
	src, _, err := image.Decode(bufio.NewReader(f))
	f.Close()
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	tw, th := w, h
	longest := w
	if h > longest {
		longest = h
	}
	if maxSide > 0 && longest > maxSide {
		s := float64(maxSide) / float64(longest)
		tw = max(1, int(float64(w)*s+0.5))
		th = max(1, int(float64(h)*s+0.5))
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	// white background first (transparent PNG → white paper)
	for i := range dst.Pix {
		dst.Pix[i] = 0xFF
	}
	if tw == w && th == h {
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Over)
	} else {
		// Scale into a transparent buffer, then composite over white.
		tmp := image.NewRGBA(image.Rect(0, 0, tw, th))
		draw.BiLinear.Scale(tmp, tmp.Bounds(), src, b, draw.Src, nil)
		draw.Draw(dst, dst.Bounds(), tmp, image.Point{}, draw.Over)
	}
	return orient(dst, e.orientation), nil
}

// orient applies an EXIF orientation to an RGBA image.
func orient(src *image.RGBA, o int) *image.RGBA {
	if o <= 1 || o > 8 {
		return src
	}
	w, h := src.Rect.Dx(), src.Rect.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			si := y*src.Stride + x*4
			di := dy*dst.Stride + dx*4
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// isGrayscale reports whether every pixel is (nearly) neutral gray.
func isGrayscale(img *image.RGBA) bool {
	p := img.Pix
	for i := 0; i+3 < len(p); i += 4 {
		r, g, b := int(p[i]), int(p[i+1]), int(p[i+2])
		if abs(r-g) > 3 || abs(g-b) > 3 || abs(r-b) > 3 {
			return false
		}
	}
	return true
}

func toGray(img *image.RGBA) *image.Gray {
	g := image.NewGray(img.Rect)
	p := img.Pix
	for i, j := 0, 0; i+3 < len(p); i, j = i+4, j+1 {
		g.Pix[j] = uint8((int(p[i])*299 + int(p[i+1])*587 + int(p[i+2])*114 + 500) / 1000)
	}
	return g
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// encodeJPEG encodes, using a 1-channel JPEG for grayscale content (smaller files).
func encodeJPEG(img *image.RGBA, quality int, allowGray bool) (data []byte, gray bool, err error) {
	var buf bytes.Buffer
	if allowGray && isGrayscale(img) {
		err = jpeg.Encode(&buf, toGray(img), &jpeg.Options{Quality: quality})
		return buf.Bytes(), true, err
	}
	err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	return buf.Bytes(), false, err
}

func lowerExt(name string) string {
	return strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
}

func decodeConfigBytes(b []byte) (image.Config, string, error) {
	return image.DecodeConfig(bytes.NewReader(b))
}

func isGrayModel(cfg image.Config) bool {
	return cfg.ColorModel == color.GrayModel || cfg.ColorModel == color.Gray16Model
}

// resizeRGBA downscales so the longest side is maxSide.
func resizeRGBA(src *image.RGBA, maxSide int) *image.RGBA {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	longest := max(w, h)
	if longest <= maxSide {
		return src
	}
	s := float64(maxSide) / float64(longest)
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(w)*s+0.5)), max(1, int(float64(h)*s+0.5))))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, src.Rect, draw.Src, nil)
	return dst
}
