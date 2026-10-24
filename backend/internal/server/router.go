package server

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/server/routes"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/web"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

const frameSrcRefreshTimeout = 5 * time.Second

// SetupRouter 配置路由器中间件和路由
func SetupRouter(
	r *gin.Engine,
	handlers *handler.Handlers,
	jwtAuth middleware2.JWTAuthMiddleware,
	optionalJWTAuth middleware2.OptionalJWTAuthMiddleware,
	adminAuth middleware2.AdminAuthMiddleware,
	apiKeyAuth middleware2.APIKeyAuthMiddleware,
	auditLog middleware2.AuditLogMiddleware,
	stepUpAuth middleware2.StepUpAuthMiddleware,
	apiKeyService *service.APIKeyService,
	subscriptionService *service.SubscriptionService,
	opsService *service.OpsService,
	settingService *service.SettingService,
	compositeResolver *service.CompositeRouteResolver,
	cfg *config.Config,
	redisClient *redis.Client,
) *gin.Engine {
	middleware2.SetIngressRejectRecorder(opsService)
	// 缓存 iframe 页面的 origin 列表，用于动态注入 CSP frame-src
	var cachedFrameOrigins atomic.Pointer[[]string]
	emptyOrigins := []string{}
	cachedFrameOrigins.Store(&emptyOrigins)

	refreshFrameOrigins := func() {
		ctx, cancel := context.WithTimeout(context.Background(), frameSrcRefreshTimeout)
		defer cancel()
		origins, err := settingService.GetFrameSrcOrigins(ctx)
		if err != nil {
			// 获取失败时保留已有缓存，避免 frame-src 被意外清空
			return
		}
		cachedFrameOrigins.Store(&origins)
	}
	refreshFrameOrigins() // 启动时初始化

	// 应用中间件
	r.Use(middleware2.RequestLogger())
	// 将客户端 IP + UA 注入 request context，供 token 签发/会话绑定/审计日志统一读取。
	// 解析模式按请求快照：兼容开关开启时信任原始转发头，关闭时使用 server.trusted_proxies。
	r.Use(middleware2.SessionBindingContext(cfg))
	r.Use(middleware2.Logger())
	r.Use(middleware2.CORS(cfg.CORS))
	r.Use(middleware2.SecurityHeaders(cfg.Security.CSP, func() []string {
		if p := cachedFrameOrigins.Load(); p != nil {
			return *p
		}
		return nil
	}))
	r.Use(middleware2.ServerTiming(cfg.Server.EnableServerTiming))

	// 投毒检测：读取配置、支持热更新，并在请求收尾时统一处置。
	// 该中间件负责释放保留尾部与改写命中后的响应；是否真正检测由账号准入决定。
	poisonStore := poison.NewStore(func() (map[string]string, error) {
		return settingService.GetRawSettings(context.Background(), poison.AllSettings())
	})
	if err := poisonStore.Reload(); err != nil {
		log.Printf("Warning: failed to load poison guard settings: %v", err)
	}
	poison.SetStore(poisonStore)
	// 启动时明确记录一次生效配置。守卫的命中日志只在真的拦到投毒时才出现，
	// 没有这一行就无法区分「开着但没命中」和「根本没开」，排查时只能靠猜。
	if snap := poison.CurrentSnapshot(); snap != nil {
		veto, strong, weak, threshold := snap.Detector.Summary()
		log.Printf("[poison] config loaded enabled=%v upstream_prefixes=%d veto=%d strong=%d weak=%d threshold=%d head_buffer=%d rotate_max=%d",
			snap.Enabled, snap.Scope.Count(), veto, strong, weak, threshold, snap.Detector.HeadRunes(), snap.RotateMax)
	}
	r.Use(poison.Middleware())

	// Serve embedded frontend with settings injection if available
	if web.HasEmbeddedFrontend() {
		frontendServer, err := web.NewFrontendServer(settingService) //nolint:staticcheck // SA4023: the !embed stub always errors; embed builds can return nil
		if err != nil {                                              //nolint:staticcheck // SA4023: see above
			log.Printf("Warning: Failed to create frontend server with settings injection: %v, using legacy mode", err)
			r.Use(web.ServeEmbeddedFrontend())
			settingService.SetOnUpdateCallback(refreshFrameOrigins)
		} else {
			// Register combined callback: invalidate HTML cache + refresh frame origins
			settingService.SetOnUpdateCallback(func() {
				frontendServer.InvalidateCache()
				refreshFrameOrigins()
			})
			r.Use(frontendServer.Middleware())
		}
	} else {
		settingService.SetOnUpdateCallback(refreshFrameOrigins)
	}

	// 投毒检测配置热更新：追加监听，不覆盖前端缓存失效等既有回调。
	settingService.AddOnUpdateCallback(func() {
		if err := poisonStore.Reload(); err != nil {
			log.Printf("Warning: failed to reload poison guard settings: %v", err)
		}
	})

	// 注册路由
	registerRoutes(r, handlers, jwtAuth, optionalJWTAuth, adminAuth, apiKeyAuth, auditLog, stepUpAuth, apiKeyService, subscriptionService, opsService, settingService, compositeResolver, cfg, redisClient)

	return r
}

// registerRoutes 注册所有 HTTP 路由
func registerRoutes(
	r *gin.Engine,
	h *handler.Handlers,
	jwtAuth middleware2.JWTAuthMiddleware,
	optionalJWTAuth middleware2.OptionalJWTAuthMiddleware,
	adminAuth middleware2.AdminAuthMiddleware,
	apiKeyAuth middleware2.APIKeyAuthMiddleware,
	auditLog middleware2.AuditLogMiddleware,
	stepUpAuth middleware2.StepUpAuthMiddleware,
	apiKeyService *service.APIKeyService,
	subscriptionService *service.SubscriptionService,
	opsService *service.OpsService,
	settingService *service.SettingService,
	compositeResolver *service.CompositeRouteResolver,
	cfg *config.Config,
	redisClient *redis.Client,
) {
	// 通用路由（健康检查、状态等）
	routes.RegisterCommonRoutes(r)

	// API v1
	v1 := r.Group("/api/v1")

	// 面板 API 限流器：认证接口按用户 ID、公开接口按安全客户端 IP，
	// 防止高频刷管理面接口打爆数据库（阈值可在系统设置中调整）。
	panelRateLimiter := middleware2.NewPanelRateLimiter(redisClient, settingService)

	// 注册各模块路由
	routes.RegisterAuthRoutes(v1, h, jwtAuth, auditLog, redisClient, settingService, panelRateLimiter)
	routes.RegisterUserRoutes(v1, h, jwtAuth, auditLog, settingService, panelRateLimiter)
	routes.RegisterModelPlazaRoutes(v1, h, optionalJWTAuth, settingService, panelRateLimiter)
	routes.RegisterAdminRoutes(v1, h, adminAuth, auditLog, stepUpAuth, settingService, panelRateLimiter)
	routes.RegisterGatewayRoutes(r, h, apiKeyAuth, apiKeyService, subscriptionService, opsService, settingService, compositeResolver, cfg)
	routes.RegisterPaymentRoutes(v1, h.Payment, h.PaymentWebhook, h.Admin.Payment, jwtAuth, adminAuth, auditLog, settingService, panelRateLimiter, redisClient)

	handler.RegisterPageRoutes(v1, cfg.Pricing.DataDir, gin.HandlerFunc(jwtAuth), gin.HandlerFunc(adminAuth), settingService)

	// 生图广场模板库：从数据目录直读，运维在服务器上增删模板无需重打二进制
	handler.RegisterImageGenAssetRoutes(v1, cfg.Pricing.DataDir)
}
