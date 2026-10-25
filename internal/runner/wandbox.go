package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

const (
	wandboxURL = "https://wandbox.org"

	// Без внятного User-Agent Wandbox отвечает 403 (проверено руками).
	// Go по умолчанию шлёт Go-http-client/1.1 — на него не полагаемся.
	userAgent = "OTORoom/1.0"

	// Wandbox сам молча режет вывод до 65536 символов, без всякого флага.
	// Наш лимит меньше этого порога, поэтому их тихую обрезку мы всегда
	// поймаем своей и честно выставим IsTruncated. Поднимать выше 64 КиБ
	// нельзя — иначе обрезанный ими вывод покажется ученику полным.
	defaultMaxOutput = 32 << 10

	// Защита памяти от стороннего сервиса: тело ответа больше этого не
	// читаем вовсе. С их собственной обрезкой реальный ответ — до ~1 МиБ.
	maxResponseBody = 2 << 20

	// Чуть больше таймаута ручки (15 с): пусть первым срабатывает контекст
	// запроса — у его ошибки понятнее причина.
	httpTimeout = 20 * time.Second
)

type compilerSpec struct {
	name    string
	options string
}

// Конкретные версии, а не *-head: head — ночные сборки и могут сломаться
// в любой момент. Список живых компиляторов — GET /api/list.json.
var compilers = map[Language]compilerSpec{
	LangCPP:    {name: "gcc-13.2.0", options: "warning,gnu++2b"},
	LangPython: {name: "cpython-3.12.7"},
}

// WandboxRunner исполняет код на wandbox.org — бесплатном публичном
// сервисе без ключей и регистрации.
type WandboxRunner struct {
	baseURL   string // поле, а не константа: в тестах подменяется адресом httptest.Server
	http      *http.Client
	maxOutput int
}

// NewWandbox создаёт раннер. maxOutput — лимит на stdout и на stderr
// по отдельности, в байтах; 0 означает лимит по умолчанию (32 КиБ).
func NewWandbox(maxOutput int) *WandboxRunner {
	if maxOutput <= 0 {
		maxOutput = defaultMaxOutput
	}
	return &WandboxRunner{
		baseURL:   wandboxURL,
		http:      &http.Client{Timeout: httpTimeout},
		maxOutput: maxOutput,
	}
}

// Формат их API. Наружу не торчит: у Docker-реализации будет свой.
type wandboxRequest struct {
	Compiler string `json:"compiler"`
	Code     string `json:"code"`
	Stdin    string `json:"stdin,omitempty"`
	Options  string `json:"options,omitempty"`
}

type wandboxResponse struct {
	Status        string `json:"status"` // код возврата, но строкой: "0", "1", "139"
	CompilerError string `json:"compiler_error"`
	ProgramOutput string `json:"program_output"`
	ProgramError  string `json:"program_error"`
	// Есть ещё signal, но он ненадёжен: на сегфолте пустой, а признак
	// приходит в status ("139"). *_message дублируют output+error вместе.
}

func (w *WandboxRunner) Run(ctx context.Context, req Request) (Response, error) {
	// Неизвестный язык отсекаем до похода в сеть.
	spec, ok := compilers[req.Language]
	if !ok {
		return Response{}, fmt.Errorf("%w: %q", ErrUnsupportedLanguage, req.Language)
	}

	body, err := json.Marshal(wandboxRequest{
		Compiler: spec.name,
		Code:     req.Code,
		Stdin:    req.Stdin,
		Options:  spec.options,
	})
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: собрать запрос: %w", err)
	}

	// Контекст в запросе: истёк таймаут ручки или ученик закрыл вкладку —
	// запрос к Wandbox обрывается сам.
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		w.baseURL+"/api/compile.json", bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", userAgent)

	start := time.Now()
	resp, err := w.http.Do(httpReq)
	if err != nil {
		// %w, а не %v: ручке нужно отличить таймаут (context.DeadlineExceeded)
		// от поломки сервиса.
		return Response{}, fmt.Errorf("wandbox: запрос: %w", err)
	}
	defer resp.Body.Close()

	// Ошибку компиляции Wandbox отдаёт с кодом 200. Не-200 — это поломка
	// самого сервиса, а не плохой код ученика.
	if resp.StatusCode != http.StatusOK {
		return Response{}, fmt.Errorf("wandbox: ответ %d", resp.StatusCode)
	}

	var wr wandboxResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBody)).Decode(&wr); err != nil {
		return Response{}, fmt.Errorf("wandbox: разобрать ответ: %w", err)
	}
	elapsed := time.Since(start)

	// Не распарсилось — ошибка, а не молчаливый 0: иначе битый ответ
	// показался бы ученику успешным запуском.
	code, err := strconv.Atoi(wr.Status)
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: непонятный status %q: %w", wr.Status, err)
	}

	// У Python нет этапа компиляции: синтаксическая ошибка приходит в
	// program_error, а не в compiler_error. Поэтому склеиваем оба поля,
	// а не выбираем одно. Компилятор первым — он и случился первым.
	stdout, cutOut := truncate(wr.ProgramOutput, w.maxOutput)
	stderr, cutErr := truncate(wr.CompilerError+wr.ProgramError, w.maxOutput)

	return Response{
		Stdout:      stdout,
		Stderr:      stderr,
		ExitCode:    code,
		Duration:    elapsed,
		IsTruncated: cutOut || cutErr,
	}, nil
}

// truncate режет строку до limit байт, не разрывая символ посередине.
// У ученика вывод с кириллицей — по два байта на букву, и разрезанная
// пополам буква превратилась бы в «�». Отступаем назад, пока s[cut] не
// станет началом символа: тогда s[:cut] заканчивается на границе.
func truncate(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}
