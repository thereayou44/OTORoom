package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/httpapi"
	sig "github.com/thereayou44/OTORoom.git/internal/signal"
)

func main() {
	cfg := config.Load()

	hub := sig.NewHub()
	api := httpapi.New(cfg, hub)
	srv := httpapi.NewHTTPServer(cfg.Addr, api.Handler())

	go func() {
		log.Println("listening http://localhost" + cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal("server down: ", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("stopping...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Println("connections aren't closed properly:", err)
	}
	log.Println("stopped")
}
