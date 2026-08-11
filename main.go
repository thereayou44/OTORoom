package main

import (
	"log"
	"net/http"

	"github.com/coder/websocket"
	"github.com/thereayou44/OTORoom.git/internal/signal"
)

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	hub := signal.NewHub()

	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		handleWS(w, r, hub)
	})

	mux.Handle("GET /", http.FileServer(http.Dir("web")))

	log.Println("listening http://localhost:8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}

func handleWS(w http.ResponseWriter, r *http.Request, h *signal.Hub) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Println("апгрейд не удался:", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	c := signal.NewClient(conn, h)
	c.Serve(r.Context())
}
