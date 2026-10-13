export default {
  batchImageGuide: {
    title: '图片批量生成',
    description: '一次提交多条提示词，任务完成后可统一下载图片结果'
  },
  // Home Page
  home: {
    viewOnGithub: '在 GitHub 上查看',
    viewDocs: '查看文档',
    docs: '文档',
    switchToLight: '切换到浅色模式',
    switchToDark: '切换到深色模式',
    dashboard: '控制台',
    login: '登录',
    getStarted: '立即开始',
    goToDashboard: '进入控制台',
    // 新增：面向用户的价值主张
    heroSubtitle: '{siteName} 提供面向开发者与团队的专业 AI API 调用服务',
    heroDescription: '统一接入主流模型能力，余额清晰、价格透明、记录可查',
    tags: {
      subscriptionToApi: '多模型接入',
      stickySession: '稳定调用',
      realtimeBilling: '统一计费'
    },
    // 用户痛点区块
    painPoints: {
      title: '你是否也遇到这些问题？',
      items: {
        expensive: {
          title: '订阅费用高',
          desc: '每个 AI 服务都要单独订阅，每月支出越来越多'
        },
        complex: {
          title: '多账号难管理',
          desc: '不同平台的账号、密钥分散各处，管理起来很麻烦'
        },
        unstable: {
          title: '服务不稳定',
          desc: '单一账号容易触发限制，影响正常使用'
        },
        noControl: {
          title: '用量无法控制',
          desc: '不知道钱花在哪了，也无法限制团队成员的使用'
        }
      }
    },
    // 解决方案区块
    solutions: {
      title: '我们帮你解决',
      subtitle: '简单三步，开始省心使用 AI'
    },
    features: {
      unifiedGateway: '多模型能力聚合',
      unifiedGatewayDesc: '主流模型能力统一接入，一个账号即可按需调用已接入的模型。',
      multiAccount: '稳定调用体验',
      multiAccountDesc: '请求自动接入可用模型服务，降低上游波动对日常开发和业务调用的影响。',
      balanceQuota: '余额与计费清晰',
      balanceQuotaDesc: '价格、余额与消费记录清楚可查，按实际用量计费，支持设置额度上限。'
    },
    // 优势对比
    comparison: {
      title: '为什么选择我们？',
      headers: {
        feature: '对比项',
        official: '官方订阅',
        us: '本平台'
      },
      items: {
        pricing: {
          feature: '付费方式',
          official: '固定月费，用不完也付',
          us: '按量付费，用多少付多少'
        },
        models: {
          feature: '模型选择',
          official: '单一服务商',
          us: '多模型随意切换'
        },
        management: {
          feature: '账号管理',
          official: '每个服务单独管理',
          us: '统一密钥，一站管理'
        },
        stability: {
          feature: '服务稳定性',
          official: '单账号易触发限制',
          us: '多账号池，自动切换'
        },
        control: {
          feature: '用量控制',
          official: '无法限制',
          us: '可设配额、查明细'
        }
      }
    },
    providers: {
      title: '已支持的 AI 模型',
      description: '一个 API，多种选择',
      supported: '已支持',
      soon: '即将推出',
      claude: 'Claude',
      gemini: 'Gemini',
      antigravity: 'Antigravity',
      more: '更多'
    },
    // CTA 区块
    cta: {
      title: 'ALL IN ONE',
      description: '从账号开通到正式调用，提供专业、稳定、可控的多模型 AI API 服务。',
      button: '立即开始'
    },
    // 粒子首页的分区文案（首页默认分支）
    sections: {
      hero: {
        title: 'ALL IN ONE',
        badge: '多模型 AI API 服务 · 稳定调用、统一计费、记录可查',
        integration: '从账号开通到正式调用，快速接入现有产品与工作流',
        assurance: '稳定、商业化、可控地使用多模型能力'
      },
      stats: {
        items: {
          platforms: {
            label: '已接入平台',
            hint: '持续扩充中'
          },
          gateways: {
            label: '入站协议族',
            hint: 'Anthropic / OpenAI / Gemini'
          },
          multiProtocol: {
            label: '多协议平台',
            hint: '按入站协议选端点'
          },
          traceability: {
            label: '请求可追溯',
            hint: '每次调用都有记录'
          }
        }
      },
      features: {
        eyebrow: '核心能力',
        title: '一个账号，接入多模型 API 服务',
        lead: '从模型选择到正式调用，统一管理模型、价格、余额与调用记录，快速接入现有产品。',
        compatTitle: '兼容现有接口',
        compatDesc: '提供 Anthropic、OpenAI 与 Gemini 入站协议，现有 SDK、自动化工作流与业务后端可按协议接入。',
        capUptime: '稳定可用',
        capUptimeDesc: '多模型服务统一接入，降低上游波动对日常开发和产品调用的影响。',
        capControl: '安全调用密钥',
        capControlDesc: '为产品、脚本或客户端创建 API Key，配合余额与额度控制使用。',
        capRecords: '记录可查',
        capRecordsDesc: '时间、模型、用量与结果逐条留痕，成本一目了然。',
        capCompat: '接入友好',
        capCompatDesc: '兼容常见 OpenAI 与 Anthropic 调用方式，方便现有工具和代码接入。',
        poolActive: '当前账号正常调度',
        poolFailover: '异常账号自动摘除',
        poolLimit: '触发限制自动切换',
        billingExample: '$0.0031',
        billingUnit: '/ 1K tokens'
      },
      howItWorks: {
        eyebrow: '使用流程',
        title: '三步开始调用',
        lead: '面向使用者呈现的是账号、余额、模型与调用记录；底层调度留在幕后，不打扰你。',
        step1Eyebrow: '开始',
        step1Title: '开通账号与余额',
        step1Desc: '开通账号后查看模型价格、充值与余额，让每一次调用都清楚可控。',
        step2Eyebrow: '调用',
        step2Title: '创建 API Key 并调用',
        step2Desc: '复制兼容 OpenAI 的调用地址，把模型能力接入产品、脚本、客户端或自动化工作流。',
        step3Eyebrow: '追踪',
        step3Title: '查看消费与调用记录',
        step3Desc: '用量、消费、错误与延迟都有记录，方便控制成本并排查调用问题。'
      },
      cta: {
        eyebrow: '开箱即用',
        summary: '多模型集成、统一计费、记录可查'
      }
    },
    footer: {
      allRightsReserved: '保留所有权利。'
    }
  },

  // Key Usage Query Page
  keyUsage: {
    title: 'API Key 用量查询',
    subtitle: '输入您的 API Key 以查看实时消费金额与使用状态',
    placeholder: 'sk-ant-mirror-xxxxxxxxxxxx',
    query: '查询',
    querying: '查询中...',
    privacyNote: '您的 Key 仅在浏览器本地处理，不会被存储',
    dateRange: '统计范围:',
    dateRangeToday: '今日',
    dateRange7d: '7 天',
    dateRange30d: '30 天',
    dateRange90d: '90 天',
    dateRangeCustom: '自定义',
    apply: '应用',
    used: '已使用',
    detailInfo: '详细信息',
    tokenStats: 'Token 统计',
    dailyDetail: '按日明细',
    modelStats: '模型用量统计',
    // Table headers
    date: '日期',
    model: '模型',
    requests: '请求数',
    inputTokens: '输入 Tokens',
    outputTokens: '输出 Tokens',
    cacheCreationTokens: '缓存创建',
    cacheReadTokens: '缓存读取',
    cacheWriteTokens: '缓存写入',
    totalTokens: '总 Tokens',
    cost: '费用',
    // Status
    quotaMode: 'Key 限额模式',
    walletBalance: '钱包余额',
    // Ring card titles
    totalQuota: '总额度',
    limit5h: '5 小时限额',
    limitDaily: '日限额',
    limit7d: '7 天限额',
    limitWeekly: '周限额',
    limitMonthly: '月限额',
    // Detail rows
    remainingQuota: '剩余额度',
    expiresAt: '过期时间',
    todayExpires: '(今日到期)',
    daysLeft: '({days} 天)',
    usedQuota: '已用额度',
    resetNow: '即将重置',
    subscriptionType: '订阅类型',
    billingType: '计费方式',
    subscriptionExpires: '订阅到期',
    // Usage stat cells
    todayRequests: '今日请求',
    todayInputTokens: '今日输入',
    todayOutputTokens: '今日输出',
    todayTokens: '今日 Tokens',
    todayCacheCreation: '今日缓存创建',
    todayCacheRead: '今日缓存读取',
    todayCost: '今日费用',
    rpmTpm: 'RPM / TPM',
    totalRequests: '累计请求',
    totalInputTokens: '累计输入',
    totalOutputTokens: '累计输出',
    totalTokensLabel: '累计 Tokens',
    totalCacheCreation: '累计缓存创建',
    totalCacheRead: '累计缓存读取',
    totalCost: '累计费用',
    avgDuration: '平均耗时',
    // Messages
    enterApiKey: '请输入 API Key',
    querySuccess: '查询成功',
    queryFailed: '查询失败',
    queryFailedRetry: '查询失败，请稍后重试',
    noDailyUsage: '暂无按日用量数据',
  },

  // Setup Wizard
  setup: {
    title: 'Sub2API 安装向导',
    description: '配置您的 Sub2API 实例',
    database: {
      title: '数据库配置',
      description: '连接到您的 PostgreSQL 数据库',
      host: '主机',
      port: '端口',
      username: '用户名',
      password: '密码',
      databaseName: '数据库名称',
      sslMode: 'SSL 模式',
      passwordPlaceholder: '密码',
      ssl: {
        disable: '禁用',
        require: '要求',
        verifyCa: '验证 CA',
        verifyFull: '完全验证'
      }
    },
    redis: {
      title: 'Redis 配置',
      description: '连接到您的 Redis 服务器',
      host: '主机',
      port: '端口',
      username: '用户名（可选）',
      password: '密码（可选）',
      database: '数据库',
      usernamePlaceholder: '默认用户留空',
      passwordPlaceholder: '密码',
      enableTls: '启用 TLS',
      enableTlsHint: '连接 Redis 时使用 TLS（公共 CA 证书）'
    },
    admin: {
      title: '管理员账户',
      description: '创建您的管理员账户',
      email: '邮箱',
      password: '密码',
      confirmPassword: '确认密码',
      passwordPlaceholder: '至少 8 个字符',
      confirmPasswordPlaceholder: '确认密码',
      passwordMismatch: '密码不匹配'
    },
    ready: {
      title: '准备安装',
      description: '检查您的配置并完成安装',
      database: '数据库',
      redis: 'Redis',
      adminEmail: '管理员邮箱'
    },
    status: {
      testing: '测试中...',
      success: '连接成功',
      testConnection: '测试连接',
      installing: '安装中...',
      completeInstallation: '完成安装',
      completed: '安装完成！',
      redirecting: '正在跳转到登录页面...',
      restarting: '服务正在重启，请稍候...',
      timeout: '服务重启时间超出预期，请手动刷新页面。'
    }
  },

  // Common
}
