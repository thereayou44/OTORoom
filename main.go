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

	mux.HandleFunc("GET /ws", handleWS)

	mux.Handle("GET /", http.FileServer(http.Dir("web")))

	log.Println("listening http://localhost:8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Println("апгрейд не удался:", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	c := signal.NewClient(conn)
	c.Serve(r.Context())
}
