package httpapi

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/coder/websocket"
	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/runner"
	"github.com/thereayou44/OTORoom.git/internal/signal"
)

type Server struct {
	hub *signal.Hub
	cfg config.Config
	web fs.FS

	// Интерфейс, а не *runner.WandboxRunner: замена Wandbox на Docker —
	// это одна строка в main.go, сюда она не дойдёт.
	runner   runner.Runner
	runSlots chan struct{} // семафор одновременных запусков, см. run.go
}

func New(cfg config.Config, hub *signal.Hub, web fs.FS, run runner.Runner) *Server {
	return &Server{
		cfg:      cfg,
		hub:      hub,
		web:      web,
		runner:   run,
		runSlots: make(chan struct{}, maxParallelRuns),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/ice", s.handleICE)
	mux.HandleFunc("POST /api/run", s.handleRun)
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.Handle("GET /", noCache(http.FileServer(http.FS(s.web))))

	return recoverer(mux)
}

// recoverer превращает панику в хендлере в ответ 500 и внятную строку в логе.
//
// Процесс от такой паники net/http спасает и сам, но клиент тогда получает
// оборванное соединение вместо ответа, а в логе — общая фраза без маршрута.
// Панику в горутине, которую запустил хендлер, этот middleware не поймает:
// она живёт в своём стеке, и защищать её надо изнутри (см. Client.write).
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			// ErrAbortHandler — штатный способ net/http намеренно оборвать
			// ответ, а не ошибка. Отдаём обратно, как и ждёт стандартная
			// библиотека: она обработает его молча.
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			log.Printf("паника в %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
			// Для /ws соединение к этому моменту уже перехвачено, и net/http
			// предупредит в логе, что писать в него поздно. Это ожидаемо.
			http.Error(w, "internal error", http.StatusInternalServerError)
		}()
		next.ServeHTTP(w, r)
	})
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
