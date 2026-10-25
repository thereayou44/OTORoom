package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/runner"
	"github.com/thereayou44/OTORoom.git/internal/signal"
)

// fakeRunner реализует runner.Runner без сети. Ради этого интерфейс и
// заводился: ручка тестируется, ни разу не обратившись к Wandbox.
type fakeRunner struct {
	res runner.Response
	err error

	// Если не nil — Run ждёт, пока канал не закроют (или не истечёт ctx).
	// Нужно, чтобы занять все места в семафоре.
	block chan struct{}

	mu          sync.Mutex
	calls       int
	got         runner.Request
	hadDeadline bool
}

func (f *fakeRunner) Run(ctx context.Context, req runner.Request) (runner.Response, error) {
	f.mu.Lock()
	f.calls++
	f.got = req
	_, f.hadDeadline = ctx.Deadline()
	f.mu.Unlock()

	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return runner.Response{}, ctx.Err()
		}
	}
	return f.res, f.err
}

func (f *fakeRunner) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newRunServer(f *fakeRunner) http.Handler {
	return New(config.Config{}, signal.NewHub(), fstest.MapFS{}, f).Handler()
}

func postRun(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/run", strings.NewReader(body)))
	return rec
}

func TestRun_SuccessMapsFields(t *testing.T) {
	f := &fakeRunner{res: runner.Response{
		Stdout:      "42\n",
		Stderr:      "warning: unused",
		ExitCode:    1, // ненулевой код — всё равно 200: запуск-то состоялся
		Duration:    812 * time.Millisecond,
		IsTruncated: true,
	}}

	rec := postRun(t, newRunServer(f), `{"language":"cpp","source":"int main(){}","stdin":"21\n"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("ждали 200, получили %d: %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q", ct)
	}

	var got runResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("ответ не json: %v", err)
	}
	want := runResponse{Stdout: "42\n", Stderr: "warning: unused",
		ExitCode: 1, DurationMs: 812, Truncated: true}
	if got != want {
		t.Fatalf("ответ %+v, ждали %+v", got, want)
	}

	// Что дошло до раннера: source с провода стал Code в доменном типе.
	f.mu.Lock()
	defer f.mu.Unlock()
	wantReq := runner.Request{Language: runner.LangCPP, Code: "int main(){}", Stdin: "21\n"}
	if f.got != wantReq {
		t.Fatalf("раннер получил %+v, ждали %+v", f.got, wantReq)
	}
	if !f.hadDeadline {
		t.Fatal("раннер получил контекст без таймаута — бесконечный цикл повесит запрос")
	}
}

func TestRun_Errors(t *testing.T) {
	big := strings.Repeat("x", maxSource+1)
	bigStdin := strings.Repeat("x", maxStdin+1)

	tests := []struct {
		name       string
		body       string
		runErr     error
		wantStatus int
		wantMsg    string
		wantCalled bool
	}{
		{"битый JSON", `{"language":`, nil, 400, msgBadRequest, false},
		{"неизвестный язык", `{"language":"go","source":"x"}`, nil, 400, msgBadLanguage, false},
		{"пустой код", `{"language":"cpp","source":"   \n"}`, nil, 400, msgEmpty, false},
		{"код больше лимита", `{"language":"cpp","source":"` + big + `"}`, nil, 400, msgTooBig, false},
		{"тело больше лимита", `{"language":"cpp","source":"` + strings.Repeat("x", maxRunBody) + `"}`, nil, 400, msgTooBig, false},
		{"ввод больше лимита", `{"language":"cpp","source":"x","stdin":"` + bigStdin + `"}`, nil, 400, msgStdinTooBig, false},
		{"таймаут", `{"language":"cpp","source":"x"}`,
			fmt.Errorf("wandbox: запрос: %w", context.DeadlineExceeded), 504, msgTimeout, true},
		{"раннер не знает язык", `{"language":"python","source":"x"}`,
			fmt.Errorf("%w: python", runner.ErrUnsupportedLanguage), 400, msgBadLanguage, true},
		{"сервис лежит", `{"language":"cpp","source":"x"}`,
			errors.New("dial tcp: lookup wandbox.org: секретная подробность"), 502, msgUnavailable, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeRunner{err: tt.runErr}
			rec := postRun(t, newRunServer(f), tt.body)

			if rec.Code != tt.wantStatus {
				t.Fatalf("статус %d, ждали %d: %s", rec.Code, tt.wantStatus, rec.Body)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Fatalf("у ошибки Content-Type %q — фронт не разберёт тело", ct)
			}

			raw := rec.Body.String()
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal([]byte(raw), &body); err != nil {
				t.Fatalf("тело ошибки не json: %q", raw)
			}
			if body.Error != tt.wantMsg {
				t.Fatalf("текст %q, ждали %q", body.Error, tt.wantMsg)
			}
			// Внутренние подробности не должны доезжать до ученика.
			if strings.Contains(raw, "секретная") || strings.Contains(raw, "dial tcp") {
				t.Fatalf("в ответ утекла внутренняя ошибка: %s", raw)
			}

			if called := f.callCount() > 0; called != tt.wantCalled {
				t.Fatalf("раннер вызван: %v, ждали %v", called, tt.wantCalled)
			}
		})
	}
}

func TestRun_GetDoesNotRunCode(t *testing.T) {
	// GET сюда не попадает: его забирает общий маршрут "GET /" (раздача
	// статики) и отвечает 404. Код ли статуса не важен — важно, что
	// запуск кода по GET невозможен.
	f := &fakeRunner{}
	rec := httptest.NewRecorder()
	newRunServer(f).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/run", nil))

	if rec.Code == http.StatusOK {
		t.Fatalf("GET /api/run не должен отвечать 200")
	}
	if f.callCount() != 0 {
		t.Fatal("GET /api/run запустил код")
	}
}

func TestRun_LimitsParallelRuns(t *testing.T) {
	f := &fakeRunner{block: make(chan struct{})}
	h := newRunServer(f)
	const body = `{"language":"cpp","source":"x"}`

	// Занимаем все места: эти запросы висят внутри раннера.
	var wg sync.WaitGroup
	codes := make(chan int, maxParallelRuns)
	for range maxParallelRuns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- postRun(t, h, body).Code
		}()
	}

	// Ждём, пока все дойдут до раннера.
	deadline := time.Now().Add(5 * time.Second)
	for f.callCount() < maxParallelRuns {
		if time.Now().After(deadline) {
			t.Fatalf("до раннера дошло %d из %d", f.callCount(), maxParallelRuns)
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Следующий получает отказ сразу, а не встаёт в очередь.
	if rec := postRun(t, h, body); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("при занятых местах ждали 429, получили %d", rec.Code)
	}

	// Отпускаем — все занятые завершаются успешно...
	close(f.block)
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != http.StatusOK {
			t.Fatalf("занявший место запрос получил %d", c)
		}
	}

	// ...и места освобождаются: новый запуск снова проходит.
	if rec := postRun(t, h, body); rec.Code != http.StatusOK {
		t.Fatalf("после освобождения ждали 200, получили %d", rec.Code)
	}
}
