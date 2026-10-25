package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/httpapi"
	"github.com/thereayou44/OTORoom.git/internal/runner"
	sig "github.com/thereayou44/OTORoom.git/internal/signal"
)

//go:embed web/*
var web embed.FS

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	hub := sig.NewHub()

	sub, err := fs.Sub(web, "web")
	if err != nil {
		log.Fatal(err)
	}
	// Код учеников исполняет Wandbox. Перейти на свой Docker — заменить эту
	// строку на другую реализацию runner.Runner; больше ничего не трогать.
	api := httpapi.New(cfg, hub, sub, runner.NewWandbox(0))

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
