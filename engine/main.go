// Flipaper — Image ⇄ PDF converter for macOS
// made by. Nevertheless_D
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// build is the app version, set with -ldflags "-X main.build=1.2.3".
var build = "0.0.0-dev"

var theApp *App

//go:embed web
var webFiles embed.FS

type Settings struct {
	Appearance    string         `json:"appearance"`    // system | light | dark
	DefaultFolder string         `json:"defaultFolder"` // "" = Downloads
	RevealAfter   bool           `json:"revealAfter"`
	AutoUpdate    bool           `json:"autoUpdate"`
	UI            map[string]any `json:"ui"` // remembered options from the screen
}

type Job struct {
	mu      sync.Mutex
	ID      string   `json:"id"`
	State   string   `json:"state"` // running | done | error | canceled
	Done    int      `json:"done"`
	Total   int      `json:"total"`
	Outputs []string `json:"outputs"`
	Error   string   `json:"error,omitempty"`
	Size    int64    `json:"size"`
	Preview bool     `json:"preview"`
	cancel  context.CancelFunc
	file    string
}

type App struct {
	support  string
	token    string
	workDir  string
	tmpDir   string
	port     int
	mu       sync.Mutex
	images   map[string]*ImageEntry
	jobs     map[string]*Job
	settings Settings
	lastSeen atomic.Int64
	running  atomic.Int32
	thumbSem chan struct{}
	upd      *Updater
}

func main() {
	log.SetFlags(log.LstdFlags)
	home, _ := os.UserHomeDir()
	support := os.Getenv("FLIPAPER_SUPPORT")
	if support == "" {
		if runtime.GOOS == "darwin" {
			support = filepath.Join(home, "Library", "Application Support", "Flipaper")
		} else {
			support = filepath.Join(home, ".flipaper")
		}
	}
	token := os.Getenv("FLIPAPER_TOKEN")
	if token == "" {
		token = randID(16)
	}
	app := &App{
		support:  support,
		token:    token,
		workDir:  filepath.Join(support, "work"),
		tmpDir:   filepath.Join(support, "tmp"),
		images:   map[string]*ImageEntry{},
		jobs:     map[string]*Job{},
		thumbSem: make(chan struct{}, max(2, runtime.NumCPU())),
	}
	os.MkdirAll(support, 0o755)
	os.RemoveAll(app.workDir)
	os.RemoveAll(app.tmpDir)
	os.MkdirAll(app.workDir, 0o755)
	os.MkdirAll(app.tmpDir, 0o755)
	app.loadSettings()
	app.lastSeen.Store(time.Now().Unix())
	theApp = app
	app.upd = NewUpdater(support)

	ln := listen(os.Getenv("FLIPAPER_PORT"))
	app.port = ln.Addr().(*net.TCPAddr).Port
	writeFileAtomic(filepath.Join(support, "token"), []byte(token), 0o600)
	writeFileAtomic(filepath.Join(support, "port"), []byte(strconv.Itoa(app.port)), 0o644)
	log.Printf("Flipaper %s listening on %d", build, app.port)

	go app.idleWatcher()
	go app.upd.autoLoop()
	srv := &http.Server{Handler: app.routes()}
	log.Fatal(srv.Serve(ln))
}

// ---------------------------------------------------------------- lifecycle

// 창을 닫고 10분 동안 아무 요청이 없으면(변환 작업도 없으면) 스스로 종료합니다.
func (a *App) idleWatcher() {
	for range time.Tick(10 * time.Second) {
		idle := time.Now().Unix() - a.lastSeen.Load()
		if idle > 600 && a.running.Load() == 0 && !a.upd.Busy() {
			a.shutdown()
		}
	}
}

func (a *App) shutdown() {
	os.RemoveAll(a.workDir)
	os.RemoveAll(a.tmpDir)
	if b, err := os.ReadFile(filepath.Join(a.support, "port")); err == nil && string(b) == strconv.Itoa(a.port) {
		os.Remove(filepath.Join(a.support, "port"))
	}
	os.Exit(0)
}

// ---------------------------------------------------------------- settings

func (a *App) settingsPath() string { return filepath.Join(a.support, "settings.json") }

func (a *App) loadSettings() {
	a.settings = Settings{Appearance: "system", RevealAfter: true, AutoUpdate: true, UI: map[string]any{}}
	if b, err := os.ReadFile(a.settingsPath()); err == nil {
		_ = json.Unmarshal(b, &a.settings)
	}
	if a.settings.UI == nil {
		a.settings.UI = map[string]any{}
	}
}

func (a *App) saveSettings() {
	b, _ := json.MarshalIndent(a.settings, "", "  ")
	writeFileAtomic(a.settingsPath(), b, 0o644)
}

func downloadsFolder() string {
	home, _ := os.UserHomeDir()
	d := filepath.Join(home, "Downloads")
	if st, err := os.Stat(d); err == nil && st.IsDir() {
		return d
	}
	return home
}

func (a *App) resolvedDefaultFolder() string {
	if f := a.settings.DefaultFolder; f != "" {
		if st, err := os.Stat(f); err == nil && st.IsDir() {
			return f
		}
	}
	return downloadsFolder()
}

// ---------------------------------------------------------------- routes

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFiles, "web")
	static := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if r.URL.Query().Get("t") != a.token {
				http.Error(w, "Flipaper 앱을 다시 실행해 주세요.", http.StatusForbidden)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			b, _ := webFiles.ReadFile("web/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(b)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".mjs") {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		w.Header().Set("Cache-Control", "max-age=3600")
		static.ServeHTTP(w, r)
	})

	api := func(path string, h http.HandlerFunc) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			t := r.Header.Get("x-token")
			if t == "" {
				t = r.URL.Query().Get("t")
			}
			if t != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			a.lastSeen.Store(time.Now().Unix())
			h(w, r)
		})
	}

	api("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "build": build})
	})
	api("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.shutdown() }()
	})
	api("/api/settings", a.handleSettings)
	api("/api/upload", a.handleUpload)
	api("/api/thumb", a.handleThumb)
	api("/api/remove", a.handleRemove)
	api("/api/estimate", a.handleEstimate)
	api("/api/build", a.handleBuild)
	api("/api/job", a.handleJob)
	api("/api/job/cancel", a.handleJobCancel)
	api("/api/job/save", a.handleJobSave)
	api("/api/job/discard", a.handleJobDiscard)
	api("/api/preview.pdf", a.handlePreviewFile)
	api("/api/save", a.handleSave)
	api("/api/mkdir", a.handleMkdir)
	api("/api/choose-folder", a.handleChooseFolder)
	api("/api/reveal", a.handleReveal)
	api("/api/open", a.handleOpen)

	api("/api/update/state", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, a.upd.State()) })
	api("/api/update/check", func(w http.ResponseWriter, r *http.Request) {
		a.upd.Check(true)
		writeJSON(w, a.upd.State())
	})
	api("/api/update/install", func(w http.ResponseWriter, r *http.Request) {
		go a.upd.Install()
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/rollback", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Rollback(); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/restart", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Restart(a.port, a.token); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})

	return hostGuard(mux)
}

// Only answer requests addressed to 127.0.0.1 / localhost (protects against DNS rebinding).
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(v)
}

// ---------------------------------------------------------------- settings API

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Method == http.MethodPost {
		var in map[string]json.RawMessage
		if err := readJSON(r, &in); err != nil {
			jsonError(w, 400, "bad request")
			return
		}
		if v, ok := in["appearance"]; ok {
			json.Unmarshal(v, &a.settings.Appearance)
		}
		if v, ok := in["defaultFolder"]; ok {
			json.Unmarshal(v, &a.settings.DefaultFolder)
		}
		if v, ok := in["revealAfter"]; ok {
			json.Unmarshal(v, &a.settings.RevealAfter)
		}
		if v, ok := in["autoUpdate"]; ok {
			json.Unmarshal(v, &a.settings.AutoUpdate)
		}
		if v, ok := in["ui"]; ok {
			var ui map[string]any
			if json.Unmarshal(v, &ui) == nil {
				for k, val := range ui {
					a.settings.UI[k] = val
				}
			}
		}
		a.saveSettings()
	}
	home, _ := os.UserHomeDir()
	writeJSON(w, map[string]any{
		"appearance":            a.settings.Appearance,
		"defaultFolder":         a.settings.DefaultFolder,
		"resolvedDefaultFolder": a.resolvedDefaultFolder(),
		"downloads":             downloadsFolder(),
		"revealAfter":           a.settings.RevealAfter,
		"autoUpdate":            a.settings.AutoUpdate,
		"ui":                    a.settings.UI,
		"home":                  home,
		"build":                 build,
	})
}

// ---------------------------------------------------------------- images

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, 405, "POST only")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "image"
	}
	id := randID(8)
	ext := lowerExt(name)
	path := filepath.Join(a.workDir, id+"."+safeExt(ext))
	f, err := os.Create(path)
	if err != nil {
		jsonError(w, 500, "임시 파일을 만들 수 없어요")
		return
	}
	n, err := io.Copy(f, r.Body)
	f.Close()
	if err != nil {
		os.Remove(path)
		jsonError(w, 500, "업로드 실패")
		return
	}
	e := &ImageEntry{ID: id, Name: name, Size: n, path: path}
	if err := analyzeImage(e, a.workDir); err != nil {
		os.Remove(path)
		jsonError(w, 415, "지원하지 않는 이미지 형식이에요: "+name)
		return
	}
	a.mu.Lock()
	a.images[id] = e
	a.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "image": e})
}

func safeExt(ext string) string {
	if ext == "" || len(ext) > 6 {
		return "bin"
	}
	for _, c := range ext {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return "bin"
		}
	}
	return ext
}

func (a *App) handleThumb(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	size, _ := strconv.Atoi(q.Get("max"))
	if size <= 0 || size > 2400 {
		size = 400
	}
	a.mu.Lock()
	e := a.images[id]
	a.mu.Unlock()
	if e == nil {
		http.NotFound(w, r)
		return
	}
	cache := filepath.Join(a.workDir, fmt.Sprintf("%s-thumb-%d.jpg", id, size))
	if _, err := os.Stat(cache); err != nil {
		a.thumbSem <- struct{}{}
		if _, err := os.Stat(cache); err != nil {
			img, err := loadScaled(e, size)
			if err != nil {
				<-a.thumbSem
				http.Error(w, "decode error", 500)
				return
			}
			tmp := cache + ".part"
			if f, err := os.Create(tmp); err == nil {
				jpeg.Encode(f, img, &jpeg.Options{Quality: 82})
				f.Close()
				os.Rename(tmp, cache)
			}
		}
		<-a.thumbSem
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, cache)
}

func (a *App) handleRemove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	a.mu.Lock()
	for _, id := range in.IDs {
		if e := a.images[id]; e != nil {
			delete(a.images, id)
			matches, _ := filepath.Glob(filepath.Join(a.workDir, id+"*"))
			for _, m := range matches {
				os.Remove(m)
			}
		}
	}
	a.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) lookup(ids []string) ([]*ImageEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]*ImageEntry, 0, len(ids))
	for _, id := range ids {
		e := a.images[id]
		if e == nil {
			return nil, errors.New("이미지 정보를 찾을 수 없어요. 이미지를 다시 넣어 주세요.")
		}
		out = append(out, e)
	}
	return out, nil
}

func (a *App) handleEstimate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []string    `json:"ids"`
		Opt PageOptions `json:"options"`
	}
	if err := readJSON(r, &in); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	items, err := a.lookup(in.IDs)
	if err != nil {
		jsonError(w, 404, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "sizes": estimateSizes(items, in.Opt)})
}

// ---------------------------------------------------------------- PDF build jobs

func (a *App) handleBuild(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs     []string    `json:"ids"`
		Opt     PageOptions `json:"options"`
		Merge   bool        `json:"merge"`
		Name    string      `json:"name"`
		Folder  string      `json:"folder"`
		Preview bool        `json:"preview"`
	}
	if err := readJSON(r, &in); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	items, err := a.lookup(in.IDs)
	if err != nil || len(items) == 0 {
		jsonError(w, 404, "변환할 이미지가 없어요")
		return
	}
	folder := in.Folder
	if !in.Preview {
		if folder == "" {
			folder = a.resolvedDefaultFolder()
		}
		if err := os.MkdirAll(folder, 0o755); err != nil {
			jsonError(w, 500, "저장 폴더에 쓸 수 없어요: "+folder)
			return
		}
	}
	name := sanitizeName(in.Name)
	if name == "" {
		name = "Flipaper_" + time.Now().Format("20060102_150405")
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{ID: randID(8), State: "running", Total: len(items), Preview: in.Preview, cancel: cancel}
	a.mu.Lock()
	a.jobs[job.ID] = job
	a.mu.Unlock()
	a.running.Add(1)

	go func() {
		defer a.running.Add(-1)
		progress := func(done int) { job.mu.Lock(); job.Done = done; job.mu.Unlock() }
		var outputs []string
		var err error
		switch {
		case in.Preview:
			path := filepath.Join(a.tmpDir, "preview-"+job.ID+".pdf")
			err = writePDF(ctx, items, in.Opt, path, name, progress)
			if err == nil {
				job.file = path
			}
		case in.Merge:
			path := uniquePath(folder, name, ".pdf")
			err = writePDF(ctx, items, in.Opt, path, name, progress)
			outputs = []string{path}
		default:
			for i, e := range items {
				base := sanitizeName(strings.TrimSuffix(e.Name, filepath.Ext(e.Name)))
				if base == "" {
					base = "image"
				}
				path := uniquePath(folder, base, ".pdf")
				if err = writePDF(ctx, []*ImageEntry{e}, in.Opt, path, base, nil); err != nil {
					break
				}
				outputs = append(outputs, path)
				progress(i + 1)
			}
		}
		job.mu.Lock()
		defer job.mu.Unlock()
		switch {
		case errors.Is(err, errCanceled):
			job.State = "canceled"
		case err != nil:
			job.State, job.Error = "error", err.Error()
		default:
			job.State = "done"
			job.Outputs = outputs
			var total int64
			for _, p := range append(outputs, job.file) {
				if st, err := os.Stat(p); err == nil && p != "" {
					total += st.Size()
				}
			}
			job.Size = total
			if !in.Preview && a.settings.RevealAfter && len(outputs) > 0 {
				reveal(outputs)
			}
		}
	}()
	writeJSON(w, map[string]any{"ok": true, "job": job.ID})
}

func (a *App) getJob(r *http.Request) *Job {
	id := r.URL.Query().Get("id")
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.jobs[id]
}

func (a *App) handleJob(w http.ResponseWriter, r *http.Request) {
	job := a.getJob(r)
	if job == nil {
		jsonError(w, 404, "작업을 찾을 수 없어요")
		return
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	writeJSON(w, job)
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	if job := a.getJob(r); job != nil {
		job.cancel()
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleJobDiscard(w http.ResponseWriter, r *http.Request) {
	if job := a.getJob(r); job != nil {
		job.cancel()
		job.mu.Lock()
		if job.file != "" {
			os.Remove(job.file)
			job.file = ""
		}
		job.mu.Unlock()
		a.mu.Lock()
		delete(a.jobs, job.ID)
		a.mu.Unlock()
	}
	writeJSON(w, map[string]any{"ok": true})
}

// 미리보기로 만든 PDF를 그대로 저장
func (a *App) handleJobSave(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder string `json:"folder"`
		Name   string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	job := a.getJob(r)
	if job == nil || job.file == "" {
		jsonError(w, 404, "미리보기 파일이 없어요. 다시 미리보기를 만들어 주세요.")
		return
	}
	folder := in.Folder
	if folder == "" {
		folder = a.resolvedDefaultFolder()
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		jsonError(w, 500, "저장 폴더에 쓸 수 없어요")
		return
	}
	name := sanitizeName(in.Name)
	if name == "" {
		name = "Flipaper_" + time.Now().Format("20060102_150405")
	}
	dest := uniquePath(folder, name, ".pdf")
	if err := copyFile(job.file, dest); err != nil {
		jsonError(w, 500, "저장하지 못했어요: "+err.Error())
		return
	}
	if a.settings.RevealAfter {
		reveal([]string{dest})
	}
	writeJSON(w, map[string]any{"ok": true, "path": dest})
}

func (a *App) handlePreviewFile(w http.ResponseWriter, r *http.Request) {
	job := a.getJob(r)
	if job == nil || job.file == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", "inline; filename=\"preview.pdf\"")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, job.file)
}

// ---------------------------------------------------------------- saving files made in the browser

// POST /api/save?folder=...&name=...&ext=...  (body = file bytes)
func (a *App) handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, 405, "POST only")
		return
	}
	q := r.URL.Query()
	folder := q.Get("folder")
	if folder == "" {
		folder = a.resolvedDefaultFolder()
	}
	ext := "." + safeExt(strings.ToLower(q.Get("ext")))
	name := sanitizeName(q.Get("name"))
	if name == "" {
		name = "Flipaper"
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		jsonError(w, 500, "저장 폴더에 쓸 수 없어요: "+folder)
		return
	}
	dest := uniquePath(folder, name, ext)
	tmp := dest + ".flipaper-part"
	f, err := os.Create(tmp)
	if err != nil {
		jsonError(w, 500, "저장 폴더에 쓸 수 없어요: "+folder)
		return
	}
	_, err = io.Copy(f, r.Body)
	f.Close()
	if err == nil {
		err = os.Rename(tmp, dest)
	}
	if err != nil {
		os.Remove(tmp)
		jsonError(w, 500, "저장하지 못했어요")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": dest})
}

func (a *App) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder string `json:"folder"`
		Name   string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	folder := in.Folder
	if folder == "" {
		folder = a.resolvedDefaultFolder()
	}
	name := sanitizeName(in.Name)
	if name == "" {
		name = "Flipaper"
	}
	dir := uniquePath(folder, name, "")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		jsonError(w, 500, "폴더를 만들 수 없어요")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": dir})
}

// ---------------------------------------------------------------- macOS helpers

func (a *App) handleChooseFolder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Start  string `json:"start"`
		Prompt string `json:"prompt"`
	}
	readJSON(r, &in)
	if t := os.Getenv("FLIPAPER_TEST_CHOOSE"); t != "" {
		writeJSON(w, map[string]any{"ok": true, "path": t})
		return
	}
	if runtime.GOOS != "darwin" {
		jsonError(w, 501, "macOS에서만 지원해요")
		return
	}
	start := in.Start
	if st, err := os.Stat(start); err != nil || !st.IsDir() {
		start = downloadsFolder()
	}
	prompt := in.Prompt
	if prompt == "" {
		prompt = "변환한 파일을 저장할 폴더를 선택하세요"
	}
	script := []string{
		"on run argv",
		"activate",
		"try",
		"set f to choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv))",
		"return POSIX path of f",
		"on error number -128",
		"return \"\"",
		"end try",
		"end run",
	}
	args := []string{}
	for _, l := range script {
		args = append(args, "-e", l)
	}
	args = append(args, start, prompt)
	out, err := exec.Command("/usr/bin/osascript", args...).Output()
	if err != nil {
		jsonError(w, 500, "폴더 선택 창을 열지 못했어요")
		return
	}
	p := strings.TrimSpace(string(out))
	if p != "" && p != "/" {
		p = strings.TrimSuffix(p, "/")
	}
	writeJSON(w, map[string]any{"ok": true, "path": p})
}

func (a *App) handleReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Paths []string `json:"paths"`
	}
	readJSON(r, &in)
	reveal(in.Paths)
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	readJSON(r, &in)
	if runtime.GOOS == "darwin" && in.Path != "" {
		exec.Command("/usr/bin/open", in.Path).Start()
	}
	writeJSON(w, map[string]any{"ok": true})
}

// reveal selects the file in Finder (or opens its folder when there are many).
func reveal(paths []string) {
	if runtime.GOOS != "darwin" || len(paths) == 0 {
		return
	}
	sort.Strings(paths)
	if len(paths) == 1 {
		exec.Command("/usr/bin/open", "-R", paths[0]).Start()
		return
	}
	exec.Command("/usr/bin/open", commonDir(paths)).Start()
}

func commonDir(paths []string) string {
	dir := filepath.Dir(paths[0])
	for _, p := range paths[1:] {
		for !strings.HasPrefix(filepath.Dir(p)+"/", dir+"/") && dir != "/" {
			dir = filepath.Dir(dir)
		}
	}
	return dir
}

// ---------------------------------------------------------------- utils

func randID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sanitizeName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '?', '%', '*', '|', '"', '<', '>', 0:
			return '-'
		}
		if r < 32 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, ".")
	if len(s) > 200 {
		rs := []rune(s)
		if len(rs) > 120 {
			s = string(rs[:120])
		}
	}
	return s
}

func uniquePath(dir, base, ext string) string {
	p := filepath.Join(dir, base+ext)
	for n := 2; ; n++ {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, n, ext))
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".flipaper-part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func writeFileAtomic(path string, b []byte, perm os.FileMode) {
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, perm) == nil {
		os.Rename(tmp, path)
	}
}

func init() {
	mime.AddExtensionType(".mjs", "text/javascript")
	mime.AddExtensionType(".bcmap", "application/octet-stream")
	_ = url.QueryEscape
}

func listen(pref string) net.Listener {
	if p, err := strconv.Atoi(pref); err == nil && p > 0 {
		for i := 0; i < 20; i++ {
			if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
				return ln
			}
			time.Sleep(150 * time.Millisecond)
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	return ln
}

func (a *App) Settings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}
