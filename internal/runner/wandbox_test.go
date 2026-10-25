package runner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// fakeWandbox отвечает заготовкой и запоминает, что к нему пришло.
type fakeWandbox struct {
	mu    sync.Mutex // хендлер пишет из горутины сервера, тест читает из своей
	calls int
	req   wandboxRequest
	ua    string
}

func (f *fakeWandbox) snapshot() (int, wandboxRequest, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, f.req, f.ua
}

func newFake(t *testing.T, status int, body string, maxOutput int) (*fakeWandbox, *WandboxRunner) {
	t.Helper()
	f := &fakeWandbox{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got wandboxRequest
		_ = json.NewDecoder(r.Body).Decode(&got)

		f.mu.Lock()
		f.calls++
		f.req = got
		f.ua = r.Header.Get("User-Agent")
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	r := NewWandbox(maxOutput)
	r.baseURL = srv.URL
	return f, r
}

// wb собирает ответ в формате Wandbox со всеми его полями.
func wb(status, compilerErr, out, progErr string) string {
	b, _ := json.Marshal(map[string]string{
		"status": status, "signal": "",
		"compiler_output": "", "compiler_error": compilerErr, "compiler_message": compilerErr,
		"program_output": out, "program_error": progErr, "program_message": out + progErr,
		"permlink": "", "url": "",
	})
	return string(b)
}

func TestRun_Success(t *testing.T) {
	f, r := newFake(t, http.StatusOK, wb("0", "", "42\n", ""), 0)

	res, err := r.Run(context.Background(), Request{
		Language: LangCPP,
		Code:     "int main(){}",
		Stdin:    "21\n",
	})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if res.Stdout != "42\n" || res.ExitCode != 0 || res.Stderr != "" || res.IsTruncated {
		t.Fatalf("неверный результат: %+v", res)
	}
	if res.Duration <= 0 {
		t.Fatalf("длительность не замерена: %v", res.Duration)
	}

	_, got, ua := f.snapshot()
	if ua != userAgent {
		t.Fatalf("User-Agent %q — без него Wandbox отвечает 403", ua)
	}
	want := wandboxRequest{Compiler: "gcc-13.2.0", Options: "warning,gnu++2b",
		Code: "int main(){}", Stdin: "21\n"}
	if got != want {
		t.Fatalf("в сервис ушло %+v, ждали %+v", got, want)
	}
}

func TestRun_CompileErrorIsNotAnError(t *testing.T) {
	_, r := newFake(t, http.StatusOK, wb("1", "prog.cc:1:13: error: ...", "", ""), 0)

	res, err := r.Run(context.Background(), Request{Language: LangCPP, Code: "oops"})
	if err != nil {
		t.Fatalf("ошибка компиляции не должна быть error: %v", err)
	}
	if res.ExitCode != 1 || !strings.Contains(res.Stderr, "error:") {
		t.Fatalf("неверный результат: %+v", res)
	}
}

func TestRun_PythonSyntaxErrorLandsInStderr(t *testing.T) {
	f, r := newFake(t, http.StatusOK, wb("1", "", "", "SyntaxError: invalid syntax\n"), 0)

	res, err := r.Run(context.Background(), Request{Language: LangPython, Code: "def f(:"})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if !strings.Contains(res.Stderr, "SyntaxError") {
		t.Fatalf("SyntaxError потерялся: %+v", res)
	}
	if _, got, _ := f.snapshot(); got.Compiler != "cpython-3.12.7" || got.Options != "" {
		t.Fatalf("для Python ушло %+v", got)
	}
}

func TestRun_StderrHasCompilerFirst(t *testing.T) {
	_, r := newFake(t, http.StatusOK, wb("1", "A", "", "B"), 0)

	res, _ := r.Run(context.Background(), Request{Language: LangCPP, Code: "x"})
	if res.Stderr != "AB" {
		t.Fatalf("stderr %q, ждали компилятор, потом программу", res.Stderr)
	}
}

func TestRun_ServiceErrorIsError(t *testing.T) {
	_, r := newFake(t, http.StatusInternalServerError, "Unexpected Server Error", 0)

	if _, err := r.Run(context.Background(), Request{Language: LangCPP, Code: "x"}); err == nil {
		t.Fatal("ответ 500 должен быть ошибкой запуска")
	}
}

func TestRun_UnsupportedLanguageSkipsNetwork(t *testing.T) {
	f, r := newFake(t, http.StatusOK, wb("0", "", "", ""), 0)

	_, err := r.Run(context.Background(), Request{Language: "brainfuck", Code: "+"})
	if !errors.Is(err, ErrUnsupportedLanguage) {
		t.Fatalf("ждали ErrUnsupportedLanguage, получили %v", err)
	}
	if calls, _, _ := f.snapshot(); calls != 0 {
		t.Fatalf("неизвестный язык не должен уходить в сеть, вызовов: %d", calls)
	}
}

func TestRun_EmptyStatusMeansStopped(t *testing.T) {
	// Так Wandbox отвечает на огромный вывод.
	_, r := newFake(t, http.StatusOK, wb("", "", "ж", ""), 0)

	res, err := r.Run(context.Background(), Request{Language: LangPython, Code: "x"})
	if err != nil {
		t.Fatalf("пустой status — не ошибка сервиса: %v", err)
	}
	if res.ExitCode != ExitStopped || !res.IsTruncated || res.Stdout != "ж" {
		t.Fatalf("ждали остановленную программу с неполным выводом: %+v", res)
	}
}

func TestRun_BadStatusIsError(t *testing.T) {
	_, r := newFake(t, http.StatusOK, wb("abc", "", "42", ""), 0)

	if _, err := r.Run(context.Background(), Request{Language: LangCPP, Code: "x"}); err == nil {
		t.Fatal("нечисловой status должен быть ошибкой")
	}
}

func TestRun_ContextCanceled(t *testing.T) {
	_, r := newFake(t, http.StatusOK, wb("0", "", "", ""), 0)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := r.Run(ctx, Request{Language: LangCPP, Code: "x"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("отмена контекста должна доезжать до вызывающего, получили %v", err)
	}
}

func TestRun_TruncatesEachStreamSeparately(t *testing.T) {
	_, r := newFake(t, http.StatusOK, wb("1", "", strings.Repeat("x", 100), "boom"), 10)

	res, err := r.Run(context.Background(), Request{Language: LangCPP, Code: "x"})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if len(res.Stdout) != 10 || !res.IsTruncated {
		t.Fatalf("stdout не обрезан: длина %d, флаг %v", len(res.Stdout), res.IsTruncated)
	}
	if res.Stderr != "boom" {
		t.Fatalf("stderr пострадал от обрезки stdout: %q", res.Stderr)
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		limit int
		want  string
		cut   bool
	}{
		{"влезает", "abc", 5, "abc", false},
		{"ровно в лимит", "abcde", 5, "abcde", false},
		{"длиннее", "abcdef", 5, "abcde", true},
		// «ждём» — по 2 байта на букву, лимит 5 приходится на середину «ё».
		{"кириллица посреди буквы", "ждём", 5, "жд", true},
		{"кириллица по границе", "ждём", 4, "жд", true},
		{"эмодзи", "a🙂b", 3, "a", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, cut := truncate(tt.in, tt.limit)
			if got != tt.want || cut != tt.cut {
				t.Fatalf("truncate(%q, %d) = %q, %v; ждали %q, %v",
					tt.in, tt.limit, got, cut, tt.want, tt.cut)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("после обрезки битый UTF-8: %q", got)
			}
		})
	}
}

func TestNewWandbox_Defaults(t *testing.T) {
	r := NewWandbox(0)
	if r.baseURL != wandboxURL || r.maxOutput != defaultMaxOutput || r.http.Timeout != httpTimeout {
		t.Fatalf("неверные значения по умолчанию: %+v", r)
	}
}
