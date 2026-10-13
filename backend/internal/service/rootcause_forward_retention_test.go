//go:build unit

package service

import (
 "context"
 "runtime"
 "strings"
 "testing"
 "time"
)

func TestRootCauseForwardSanitizedBodyWhileResponsePending(t *testing.T) {
 for _, mode := range []string{"openai-valid", "openai-sanitized", "grok"} {
  t.Run(mode, func(t *testing.T) {
   id := "msg_valid"
   if mode == "openai-sanitized" { id = "item_invalid" }
   body := []byte(`{"model":"gpt-test","stream":false,"input":[{"type":"message","id":"`+id+`","role":"user","content":[{"type":"input_text","text":"`+strings.Repeat("a",16<<20)+`"}]}]}`)
   c,_ := newOpenAIImageGenerationControlTestContext(true,"synthetic")
   account := newOpenAIImageGenerationControlTestAccount()
   account.Extra = map[string]any{"openai_passthrough":true}
   if mode == "grok" { account.Platform = PlatformGrok }
   u := &retentionUpstream{readStarted:make(chan struct{}),release:make(chan struct{})}
   s := newOpenAIImageGenerationControlTestService(nil)
   s.httpUpstream = u
   runtime.GC(); runtime.GC()
   var before, during runtime.MemStats
   runtime.ReadMemStats(&before)
   done := make(chan error,1)
   go func(){ _,err := s.Forward(context.Background(),c,account,body);done<-err }()
   select {
   case <-u.readStarted:
   case err := <-done: t.Fatalf("exited before response read: %v",err)
   case <-time.After(20*time.Second): close(u.release);t.Fatal("response read not reached")
   }
   runtime.GC();runtime.GC();runtime.ReadMemStats(&during)
   extra:=int64(during.HeapAlloc)-int64(before.HeapAlloc)
   close(u.release)
   select { case err:=<-done:if err!=nil {t.Fatal(err)};case <-time.After(20*time.Second):t.Fatal("did not finish") }
   t.Logf("mode=%s input=%d extra_retained_while_response_pending=%d",mode,len(body),extra)
   if extra > 8<<20 { t.Errorf("more than half a request body retained redundantly: %d",extra) }
   runtime.KeepAlive(body);runtime.KeepAlive(c);runtime.KeepAlive(u)
  })
 }
}
