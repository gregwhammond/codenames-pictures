// Command codenames-pictures serves Goat Pic, a realtime Codenames-style picture game.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

//go:embed web
var embedded embed.FS

var imageExtensions = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true, ".svg": true}

func init() {
	// Go's built-in table has no entry for the app manifest, and the
	// distroless image has no /etc/mime.types to fall back on.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

func main() {
	addr := flag.String("addr", "", "listen address (default :$PORT or :8080)")
	cardsDir := flag.String("cards", "", "serve card pictures from this folder instead of the built-in set")
	largeDir := flag.String("large", "cards-large", "folder of zoom-size card pictures served at /cards-large/")
	dev := flag.Bool("dev", false, "serve the four-phone development harness at /dev")
	flag.Parse()

	if *addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		*addr = ":" + port
	}

	web, _ := fs.Sub(embedded, "web")
	var cards fs.FS
	if *cardsDir != "" {
		cards = os.DirFS(*cardsDir)
	} else {
		cards, _ = fs.Sub(web, "cards")
	}

	if st, err := os.Stat(*largeDir); err != nil || !st.IsDir() {
		log.Printf("no large pictures folder %q: /cards-large/ will return 404", *largeDir)
	}
	// Built-in tiles carry a hash of their crop in the file name. Pictures
	// from a folder don't, so their URLs get a version that changes when the
	// file does: phones cache pictures for a long time.
	srv, err := newServer(web, cards, os.DirFS(*largeDir), *cardsDir != "")
	if err != nil {
		log.Fatal(err)
	}
	if *dev {
		srv.EnableDev()
	}
	go func() {
		for range time.Tick(10 * time.Minute) {
			srv.rooms.Sweep(6 * time.Hour)
		}
	}()

	log.Printf("Goat Pic listening on %s with %d pictures", *addr, len(srv.images))
	if *dev {
		host := *addr
		if strings.HasPrefix(host, ":") {
			host = "localhost" + host
		}
		log.Printf("development harness at http://%s/dev", host)
	}
	log.Fatal(http.ListenAndServe(*addr, srv))
}

type Server struct {
	mux    *http.ServeMux
	rooms  *Rooms
	images []string
	web    fs.FS
}

// listImages finds the pictures to deal. It returns their URLs (each path
// segment percent-encoded, so names with "#", "?" or "%" still load) and the
// set of file paths those URLs stand for. Hidden files and folders are left
// out. With versioned set, each URL ends in "?v=" plus a short hash of the
// file's size and modification time.
func listImages(cards fs.FS, versioned bool) ([]string, map[string]bool, error) {
	var images []string
	files := map[string]bool{}
	err := fs.WalkDir(cards, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		hidden := strings.HasPrefix(d.Name(), ".") && p != "."
		if d.IsDir() {
			if hidden {
				return fs.SkipDir
			}
			return nil
		}
		if hidden || !imageExtensions[strings.ToLower(path.Ext(p))] {
			return nil
		}
		segments := strings.Split(p, "/")
		for i, s := range segments {
			segments[i] = url.PathEscape(s)
		}
		u := "/cards/" + strings.Join(segments, "/")
		if versioned {
			if info, err := d.Info(); err == nil {
				h := fnv.New32a()
				fmt.Fprintf(h, "%d %d", info.Size(), info.ModTime().UnixNano())
				u += fmt.Sprintf("?v=%08x", h.Sum32())
			}
		}
		images = append(images, u)
		files[p] = true
		return nil
	})
	sort.Strings(images)
	return images, files, err
}

// noListing answers 404 for folders instead of letting the file server list
// their contents. The root is let through when allowRoot is set (it serves
// index.html).
func noListing(fsys fs.FS, prefix string, allowRoot bool, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.Trim(path.Clean("/"+strings.TrimPrefix(r.URL.Path, prefix)), "/")
		if name == "" {
			name = "."
		}
		if name != "." || !allowRoot {
			if st, err := fs.Stat(fsys, name); err == nil && st.IsDir() {
				http.NotFound(w, r)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

// NewServer builds the HTTP handler. large holds the zoom-size pictures served
// at /cards-large/ under the same file names as /cards/; it may be nil or point
// at a missing folder, in which case those requests get 404.
func NewServer(web, cards, large fs.FS) (*Server, error) {
	return newServer(web, cards, large, false)
}

// newServer is NewServer with the choice of versioned picture URLs (see
// listImages), used when the pictures come from a folder.
func newServer(web, cards, large fs.FS, versioned bool) (*Server, error) {
	images, cardFiles, err := listImages(cards, versioned)
	if err != nil {
		return nil, err
	}
	if len(images) < CardCount {
		return nil, fmt.Errorf("need at least %d pictures, found %d", CardCount, len(images))
	}
	s := &Server{mux: http.NewServeMux(), rooms: NewRooms(images), images: images, web: web}

	s.mux.HandleFunc("POST /api/rooms", s.handleCreate)
	s.mux.HandleFunc("POST /api/rooms/{code}/{action}", s.handleAction)
	s.mux.HandleFunc("GET /api/rooms/{code}/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })

	static := noListing(web, "/", true, http.FileServerFS(web))
	// Only the pictures that can be dealt are served: nothing else that
	// happens to be in the folder, and no listing of it.
	cardServer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/cards/")
		if !cardFiles[name] {
			http.NotFound(w, r)
			return
		}
		http.ServeFileFS(w, r, cards, name)
	})
	s.mux.Handle("GET /cards/", cacheFor(30*24*time.Hour, cardServer))
	if large != nil {
		// Zoom pictures share the tiles' names, so only those are served:
		// nothing else that happens to be in the folder (notes, dotfiles).
		largeServer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name := strings.TrimPrefix(r.URL.Path, "/cards-large/")
			if !cardFiles[name] {
				http.NotFound(w, r)
				return
			}
			http.ServeFileFS(w, r, large, name)
		})
		s.mux.Handle("GET /cards-large/", cacheFor(30*24*time.Hour, largeServer))
	} else {
		s.mux.Handle("GET /cards-large/", http.NotFoundHandler())
	}
	s.mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The dev harness lives at /dev (see EnableDev), never as a plain file.
		if r.URL.Path == "/dev.html" {
			http.NotFound(w, r)
			return
		}
		// Room links like /r/ABCD load the app shell.
		if strings.HasPrefix(r.URL.Path, "/r/") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			r = r2
		}
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// EnableDev serves the four-phone development harness (web/dev.html) at /dev.
// Without it the path falls through to the app's file server, which has no
// file called "dev" and answers 404; /dev.html is refused there too, so the
// harness is reachable only through this route. Call it once, before serving.
func (s *Server) EnableDev() {
	s.mux.HandleFunc("GET /dev", func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(s.web, "dev.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	})
}

// cacheFor marks successful responses as cacheable for d. Errors (a picture
// that isn't there yet) are left uncached so they don't stick in browsers.
func cacheFor(d time.Duration, h http.Handler) http.Handler {
	value := fmt.Sprintf("public, max-age=%d", int(d.Seconds()))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(&cachingWriter{ResponseWriter: w, value: value}, r)
	})
}

type cachingWriter struct {
	http.ResponseWriter
	value       string
	wroteHeader bool
}

func (c *cachingWriter) WriteHeader(status int) {
	if !c.wroteHeader {
		c.wroteHeader = true
		if status < 400 {
			c.Header().Set("Cache-Control", c.value)
		}
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *cachingWriter) Write(b []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	room, err := s.rooms.Create()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": room.Code})
}

type actionRequest struct {
	Token  string `json:"token"`
	Name   string `json:"name"`
	Team   Team   `json:"team"`
	Role   Role   `json:"role"`
	Word   string `json:"word"`
	Number *int   `json:"number"`
	Index  *int   `json:"index"`
}

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	room, ok := s.rooms.Get(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("no room with that code"))
		return
	}
	var req actionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("bad request"))
		return
	}

	var err error
	switch r.PathValue("action") {
	case "join":
		_, err = room.Join(req.Token, req.Name)
	case "sit":
		err = room.Do(req.Token, func(p *Player) error { return room.Sit(p, req.Team, req.Role) })
	case "start":
		err = room.Do(req.Token, func(*Player) error { return room.Start() })
	case "lobby":
		err = room.Do(req.Token, func(*Player) error { room.BackToLobby(); return nil })
	case "clue":
		err = room.Do(req.Token, func(p *Player) error {
			if req.Number == nil { // a missing number is not 0
				return ErrBadNumber
			}
			return room.Clue(p, req.Word, *req.Number)
		})
	case "guess":
		err = room.Do(req.Token, func(p *Player) error {
			if req.Index == nil { // a missing card is not card 0
				return ErrBadCard
			}
			return room.Guess(p, *req.Index)
		})
	case "end-turn":
		err = room.Do(req.Token, func(p *Player) error { return room.EndTurn(p) })
	case "leave":
		err = room.Do(req.Token, func(p *Player) error { room.Leave(p); return nil })
	case "view":
		// Changes nothing: a reconnecting phone asks for its view, and learns
		// from a 403 that it has left the room (perhaps from another tab).
		if _, ok := room.View(req.Token); !ok {
			err = ErrUnknownPlayer
		}
	default:
		writeError(w, http.StatusNotFound, errors.New("unknown action"))
		return
	}
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, ErrUnknownPlayer) {
			status = http.StatusForbidden
		}
		writeError(w, status, err)
		return
	}
	if v, ok := room.View(req.Token); ok {
		writeJSON(w, http.StatusOK, v)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleEvents streams the room state to one player with Server-Sent Events.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	room, ok := s.rooms.Get(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("no room with that code"))
		return
	}
	token := r.URL.Query().Get("token")
	ch, player, err := room.Subscribe(token)
	if err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}
	defer room.Unsubscribe(player, ch)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	send := func() bool {
		// The stream belongs to the player it was opened for: if they left,
		// even if the same token has joined again since, it is over.
		v, ok := room.ViewOf(token, player)
		if !ok {
			fmt.Fprint(w, "event: gone\ndata: {}\n\n")
			flusher.Flush()
			return false
		}
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			if !send() {
				return
			}
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
