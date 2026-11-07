package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/thereayou44/OTORoom.git/internal/runner"
)

// POST /api/run. 200 — запуск состоялся (даже если код не скомпилировался:
// тогда текст в stderr и exitCode != 0). Не-200 — запустить не смогли,
// тело {"error": "..."} фронт показывает ученику как есть.

const (
	maxRunBody = 128 << 10
	maxSource  = 64 << 10
	maxStdin   = 16 << 10

	// bits/stdc++.h компилируется ~10 с — 15 с оставляли программе слишком мало.
	runTimeout = 30 * time.Second

	// Общий на сервер: не нагружать бесплатный Wandbox, иначе забанят адрес.
	maxParallelRuns = 4
)

type runRequest struct {
	Language string `json:"language"`
	Source   string `json:"source"`
	Stdin    string `json:"stdin"`
}

type runResponse struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Truncated  bool   `json:"truncated"`
}

const (
	msgBadRequest  = "не удалось разобрать запрос"
	msgBadLanguage = "неизвестный язык"
	msgEmpty       = "нечего запускать — код пустой"
	msgTooBig      = "код слишком большой (больше 64 КБ)"
	msgStdinTooBig = "ввод слишком большой (больше 16 КБ)"
	msgBusy        = "сейчас слишком много запусков, попробуй через пару секунд"
	msgTimeout     = "запуск занял больше 30 секунд — возможно, в программе бесконечный цикл"
	msgUnavailable = "сервис запуска сейчас недоступен, попробуй позже"
)

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRunBody)

	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			runError(w, http.StatusBadRequest, msgTooBig)
			return
		}
		runError(w, http.StatusBadRequest, msgBadRequest)
		return
	}

	lang := runner.Language(req.Language)
	switch {
	case lang != runner.LangCPP && lang != runner.LangPython:
		runError(w, http.StatusBadRequest, msgBadLanguage)
		return
	case strings.TrimSpace(req.Source) == "":
		runError(w, http.StatusBadRequest, msgEmpty)
		return
	case len(req.Source) > maxSource:
		runError(w, http.StatusBadRequest, msgTooBig)
		return
	case len(req.Stdin) > maxStdin:
		runError(w, http.StatusBadRequest, msgStdinTooBig)
		return
	}

	// Без очереди: лучше сразу отказать, чем держать запрос висящим.
	select {
	case s.runSlots <- struct{}{}:
		defer func() { <-s.runSlots }()
	default:
		runError(w, http.StatusTooManyRequests, msgBusy)
		return
	}

	// От r.Context(): закрыли вкладку — запрос к Wandbox оборвётся.
	ctx, cancel := context.WithTimeout(r.Context(), runTimeout)
	defer cancel()

	res, err := s.runner.Run(ctx, runner.Request{
		Language: lang,
		Code:     req.Source,
		Stdin:    req.Stdin,
	})
	if err != nil {
		switch {
		case errors.Is(err, runner.ErrUnsupportedLanguage):
			runError(w, http.StatusBadRequest, msgBadLanguage)
		case errors.Is(err, context.DeadlineExceeded):
			runError(w, http.StatusGatewayTimeout, msgTimeout)
		case errors.Is(err, context.Canceled):
			// клиент ушёл — отвечать некому
		default:
			log.Println("запуск кода не удался:", err) // наружу детали не отдаём
			runError(w, http.StatusBadGateway, msgUnavailable)
		}
		return
	}

	writeJSON(w, http.StatusOK, runResponse{
		Stdout:     res.Stdout,
		Stderr:     res.Stderr,
		ExitCode:   res.ExitCode,
		DurationMs: res.Duration.Milliseconds(),
		Truncated:  res.IsTruncated,
	})
}

func runError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Println("не удалось отдать ответ:", err)
	}
}
