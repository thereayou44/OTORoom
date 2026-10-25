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

// POST /api/run — запуск кода из редактора.
//
// Контракт с фронтом (web/app.js, runCode):
//
//	запрос: {"language": "cpp"|"python", "source": "...", "stdin": "..."}
//	200:    {"stdout", "stderr", "exitCode", "durationMs", "truncated"}
//	ошибка: любой не-200 с телом {"error": "текст для человека"}
//
// Главное правило: 200 означает «запуск состоялся» — даже если код не
// скомпилировался (тогда текст компилятора в stderr, exitCode ненулевой).
// exitCode -1 (runner.ExitStopped) — программу остановили до завершения,
// например за слишком большой вывод; вывод тогда неполный.
// Не-200 означает «запустить не смогли». Так фронт отличает «твой код
// плохой» от «у нас проблемы».
//
// Здесь вся политика доступа — лимиты, таймаут, число запусков. Раннер про
// неё не знает: он только исполняет.

const (
	maxRunBody = 128 << 10 // всё тело запроса, режется до разбора JSON
	maxSource  = 64 << 10
	maxStdin   = 16 << 10

	runTimeout = 15 * time.Second

	// Общий лимит на сервер, а не на комнату: в запросе нет номера комнаты,
	// а двойной клик фронт и так не пускает. Нужен он, чтобы не устроить
	// нагрузку бесплатному публичному Wandbox — забанить могут весь адрес
	// Render, и тогда запуск сломается у всех.
	maxParallelRuns = 4
)

// Формат провода. Отдельно от runner.Request намеренно: снаружи camelCase и
// длительность в миллисекундах, внутри — гошные имена и time.Duration.
// Повесь теги на доменный тип — и он начнёт зависеть от формата нашего API.
type runRequest struct {
	Language string `json:"language"`
	Source   string `json:"source"` // в runner.Request это поле Code
	Stdin    string `json:"stdin"`
}

type runResponse struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Truncated  bool   `json:"truncated"`
}

// Тексты ниже фронт показывает ученику дословно — поэтому по-русски и
// по-человечески.
const (
	msgBadRequest  = "не удалось разобрать запрос"
	msgBadLanguage = "неизвестный язык"
	msgEmpty       = "нечего запускать — код пустой"
	msgTooBig      = "код слишком большой (больше 64 КБ)"
	msgStdinTooBig = "ввод слишком большой (больше 16 КБ)"
	msgBusy        = "сейчас слишком много запусков, попробуй через пару секунд"
	msgTimeout     = "запуск занял больше 15 секунд — возможно, в программе бесконечный цикл"
	msgUnavailable = "сервис запуска сейчас недоступен, попробуй позже"
)

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	// Лимит на тело — до разбора: иначе злой клиент заставит читать в
	// память сколько угодно.
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

	// Неблокирующая попытка занять место. В очередь не ставим: держать
	// запрос висящим ради чужого запуска хуже, чем честно отказать сразу.
	select {
	case s.runSlots <- struct{}{}:
		defer func() { <-s.runSlots }()
	default:
		runError(w, http.StatusTooManyRequests, msgBusy)
		return
	}

	// r.Context(), а не Background: ученик закрыл вкладку — запрос к
	// Wandbox оборвётся сам, место в семафоре освободится.
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
			// После проверки выше сюда не дойдёт, но реализация раннера
			// может поддерживать меньше языков, чем ручка.
			runError(w, http.StatusBadRequest, msgBadLanguage)
		case errors.Is(err, context.DeadlineExceeded):
			runError(w, http.StatusGatewayTimeout, msgTimeout)
		case errors.Is(err, context.Canceled):
			// Клиент ушёл — отвечать некому.
		default:
			// Настоящую причину — только в лог. Наружу не должны утекать
			// адреса и внутренние детали, да и ученику ни к чему видеть
			// «dial tcp: lookup wandbox.org».
			log.Println("запуск кода не удался:", err)
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
