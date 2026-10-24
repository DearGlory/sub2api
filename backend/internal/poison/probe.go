package poison

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EgressProber 通过指定代理请求一个回显服务，取得实际出口 IP。
//
// 动态代理的出口 IP 与 proxies.host 无关，只有实际探测才能知道本次会话用的是
// 哪个 IP；黑名单必须按真实出口 IP 记录，否则会误封整条代理或漏掉已知脏 IP。
type EgressProber struct {
	// Endpoints 依次尝试的回显地址，返回纯文本 IP。
	Endpoints []string
	// Timeout 是单次探测的总超时。
	Timeout time.Duration
}

// DefaultEgressProber 返回默认探测配置。
func DefaultEgressProber() *EgressProber {
	return &EgressProber{
		Endpoints: []string{
			"https://api.ipify.org",
			"https://ifconfig.me/ip",
			"https://icanhazip.com",
		},
		Timeout: 5 * time.Second,
	}
}

// Probe 通过 proxyURL 探测出口 IP。proxyURL 为空时探测直连出口。
//
// 全部端点失败时返回错误，调用方应回退到代理 host 作为出口 IP 的近似值。
func (p *EgressProber) Probe(ctx context.Context, proxyURL string) (string, error) {
	if p == nil {
		return "", fmt.Errorf("no prober")
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	endpoints := p.Endpoints
	if len(endpoints) == 0 {
		endpoints = DefaultEgressProber().Endpoints
	}

	transport := &http.Transport{
		DisableKeepAlives: true,
	}
	if proxyURL != "" {
		parsed, err := parseProxyURL(proxyURL)
		if err != nil {
			return "", err
		}
		transport.Proxy = http.ProxyURL(parsed)
	}

	client := &http.Client{Transport: transport, Timeout: timeout}
	var lastErr error
	for _, endpoint := range endpoints {
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 256))
		resp.Body.Close()
		cancel()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		ip := strings.TrimSpace(string(body))
		if net.ParseIP(ip) != nil {
			return ip, nil
		}
		lastErr = fmt.Errorf("endpoint %s returned non-IP %q", endpoint, ip)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no endpoint available")
	}
	return "", lastErr
}

// parseProxyURL 接受 host:port 或完整 URL 两种写法。
func parseProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty proxy url")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return url.Parse(raw)
}
