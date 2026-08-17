package httpapi

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/signal"
)

type Server struct {
	hub *signal.Hub
	cfg config.Config
	web fs.FS
}

func New(cfg config.Config, hub *signal.Hub, web fs.FS) *Server {
	return &Server{cfg: cfg, hub: hub, web: web}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/ice", s.handleICE)
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.Handle("GET /", noCache(http.FileServer(http.FS(s.web))))

	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("OK"))
}

type iceServer struct {
	URLs       string `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

func (s *Server) handleICE(w http.ResponseWriter, r *http.Request) {
	servers := []iceServer{
		{URLs: "stun:stun.l.google.com:19302"},
	}

	if s.cfg.HasTURN() {
		servers = append(servers, iceServer{
			URLs:       s.cfg.TURNURL,
			Username:   s.cfg.TURNUser,
			Credential: s.cfg.TURNPass,
		},
		)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	if err := json.NewEncoder(w).Encode(map[string]any{"iceServers": servers}); err != nil {
		log.Println("не удалось отдать ICE-конфиг:", err)
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.cfg.Origins,
	})
	if err != nil {
		log.Println("апгрейд не удался:", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	c := signal.NewClient(conn, s.hub)
	c.Serve(r.Context())
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func NewHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}
