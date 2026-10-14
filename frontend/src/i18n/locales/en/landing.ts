export default {
  batchImageGuide: {
    title: 'Batch Image Generation',
    description: 'Submit multiple prompts in one job and download the generated images when complete'
  },
  // Home Page
  home: {
    viewOnGithub: 'View on GitHub',
    viewDocs: 'View Documentation',
    docs: 'Docs',
    switchToLight: 'Switch to Light Mode',
    switchToDark: 'Switch to Dark Mode',
    dashboard: 'Dashboard',
    login: 'Login',
    getStarted: 'Get Started',
    goToDashboard: 'Go to Dashboard',
    // User-focused value proposition
    heroSubtitle: '{siteName} provides professional AI API services for developers and teams',
    heroDescription: 'Access leading models through one service, with clear balances, transparent pricing and traceable requests',
    tags: {
      subscriptionToApi: 'Multiple Models',
      stickySession: 'Stable Access',
      realtimeBilling: 'Unified Billing'
    },
    // Pain points section
    painPoints: {
      title: 'Sound Familiar?',
      items: {
        expensive: {
          title: 'High Subscription Costs',
          desc: 'Paying for multiple AI subscriptions that add up every month'
        },
        complex: {
          title: 'Account Chaos',
          desc: 'Managing scattered accounts and API keys across different platforms'
        },
        unstable: {
          title: 'Service Interruptions',
          desc: 'Single accounts hitting rate limits and disrupting your workflow'
        },
        noControl: {
          title: 'No Usage Control',
          desc: "Can't track where your money goes or limit team member usage"
        }
      }
    },
    // Solutions section
    solutions: {
      title: 'We Solve These Problems',
      subtitle: 'Three simple steps to stress-free AI access'
    },
    features: {
      unifiedGateway: 'Multiple Models, One Account',
      unifiedGatewayDesc: 'Access leading model services through one account and call the connected models as needed.',
      multiAccount: 'Stable API Access',
      multiAccountDesc: 'Requests route to available model services, reducing the impact of upstream disruptions on development and production.',
      balanceQuota: 'Clear Balances and Billing',
      balanceQuotaDesc: 'Review prices, balances and spending records. Pay for actual usage and set spending limits.'
    },
    // Comparison section
    comparison: {
      title: 'Why Choose Us?',
      headers: {
        feature: 'Comparison',
        official: 'Official Subscriptions',
        us: 'Our Platform'
      },
      items: {
        pricing: {
          feature: 'Pricing',
          official: 'Fixed monthly fee, pay even if unused',
          us: 'Pay only for what you use'
        },
        models: {
          feature: 'Model Selection',
          official: 'Single provider only',
          us: 'Switch between models freely'
        },
        management: {
          feature: 'Account Management',
          official: 'Manage each service separately',
          us: 'Unified key, one dashboard'
        },
        stability: {
          feature: 'Stability',
          official: 'Single account rate limits',
          us: 'Multi-account pool, auto-failover'
        },
        control: {
          feature: 'Usage Control',
          official: 'Not available',
          us: 'Quotas & detailed analytics'
        }
      }
    },
    providers: {
      title: 'Supported AI Models',
      description: 'One API, Multiple Choices',
      supported: 'Supported',
      soon: 'Soon',
      claude: 'Claude',
      gemini: 'Gemini',
      antigravity: 'Antigravity',
      more: 'More'
    },
    // CTA section
    cta: {
      title: 'ALL IN ONE',
      description: 'From account setup to production calls, access professional, stable multi-model AI API services with usage under your control.',
      button: 'Get Started'
    },
    // Copy for the particle home page's sections (the default branch)
    sections: {
      hero: {
        title: 'ALL IN ONE',
        badge: 'Multi-model AI API services · Stable access, unified billing, traceable requests',
        integration: 'From account setup to production calls, integrate quickly into your products and workflows',
        assurance: 'Use multiple models reliably, commercially and with control'
      },
      stats: {
        items: {
          platforms: {
            label: 'Platforms onboarded',
            hint: 'Growing continuously'
          },
          gateways: {
            label: 'Inbound protocols',
            hint: 'Anthropic / OpenAI / Gemini'
          },
          multiProtocol: {
            label: 'Multi-protocol platforms',
            hint: 'Endpoint chosen per protocol'
          },
          traceability: {
            label: 'Requests traced',
            hint: 'Every call is recorded'
          }
        }
      },
      features: {
        eyebrow: 'Core capabilities',
        title: 'One account for multi-model API services',
        lead: 'From model selection to production calls, manage models, prices, balances and request history in one place and integrate into existing products.',
        compatTitle: 'Compatible Interfaces',
        compatDesc: 'Anthropic, OpenAI and Gemini inbound protocols let existing SDKs, automation and backends connect through their supported protocol.',
        capUptime: 'Reliably available',
        capUptimeDesc: 'Unified model access reduces the impact of upstream disruptions on development and production calls.',
        capControl: 'Secure API Keys',
        capControlDesc: 'Create an API Key for products, scripts or clients, with balances and quotas to control usage.',
        capRecords: 'Records you can audit',
        capRecordsDesc: 'Time, model, usage and outcome are logged per request, so cost is never a mystery.',
        capCompat: 'Easy to adopt',
        capCompatDesc: 'Common OpenAI and Anthropic interfaces help existing tools and code connect easily.',
        poolActive: 'Account serving traffic',
        poolFailover: 'Failed account removed',
        poolLimit: 'Rate-limited account switched',
        billingExample: '$0.0031',
        billingUnit: '/ 1K tokens'
      },
      howItWorks: {
        eyebrow: 'How it works',
        title: 'Three steps to your first call',
        lead: 'What you see is your account, balance, models and request history. The scheduling underneath stays out of the way.',
        step1Eyebrow: 'Start',
        step1Title: 'Set up your account and balance',
        step1Desc: 'Open an account, then review model prices, top-ups and your balance so every call is a known cost.',
        step2Eyebrow: 'Call',
        step2Title: 'Create an API Key and call models',
        step2Desc: 'Copy the OpenAI-compatible endpoint and connect models to your product, scripts, clients or automation.',
        step3Eyebrow: 'Track',
        step3Title: 'Review spend and request logs',
        step3Desc: 'Usage, cost, errors and latency are all recorded, which makes budgeting and debugging straightforward.'
      },
      cta: {
        eyebrow: 'Ready out of the box',
        summary: 'Multiple models, unified billing, traceable requests'
      }
    },
    footer: {
      allRightsReserved: 'All rights reserved.'
    }
  },

  // Key Usage Query Page
  keyUsage: {
    title: 'API Key Usage',
    subtitle: 'Enter your API Key to view real-time spending and usage status',
    placeholder: 'sk-ant-mirror-xxxxxxxxxxxx',
    query: 'Query',
    querying: 'Querying...',
    privacyNote: 'Your Key is processed locally in the browser and will not be stored',
    dateRange: 'Date Range:',
    dateRangeToday: 'Today',
    dateRange7d: '7 Days',
    dateRange30d: '30 Days',
    dateRange90d: '90 Days',
    dateRangeCustom: 'Custom',
    apply: 'Apply',
    used: 'Used',
    detailInfo: 'Detail Information',
    tokenStats: 'Token Statistics',
    dailyDetail: 'Daily Detail',
    modelStats: 'Model Usage Statistics',
    // Table headers
    date: 'Date',
    model: 'Model',
    requests: 'Requests',
    inputTokens: 'Input Tokens',
    outputTokens: 'Output Tokens',
    cacheCreationTokens: 'Cache Creation',
    cacheReadTokens: 'Cache Read',
    cacheWriteTokens: 'Cache Write',
    totalTokens: 'Total Tokens',
    cost: 'Cost',
    // Status
    quotaMode: 'Key Quota Mode',
    walletBalance: 'Wallet Balance',
    // Ring card titles
    totalQuota: 'Total Quota',
    limit5h: '5-Hour Limit',
    limitDaily: 'Daily Limit',
    limit7d: '7-Day Limit',
    limitWeekly: 'Weekly Limit',
    limitMonthly: 'Monthly Limit',
    // Detail rows
    remainingQuota: 'Remaining Quota',
    expiresAt: 'Expires At',
    todayExpires: '(expires today)',
    daysLeft: '({days} days)',
    usedQuota: 'Used Quota',
    resetNow: 'Resetting soon',
    subscriptionType: 'Subscription Type',
    billingType: 'Billing Type',
    subscriptionExpires: 'Subscription Expires',
    // Usage stat cells
    todayRequests: 'Today Requests',
    todayInputTokens: 'Today Input',
    todayOutputTokens: 'Today Output',
    todayTokens: 'Today Tokens',
    todayCacheCreation: 'Today Cache Creation',
    todayCacheRead: 'Today Cache Read',
    todayCost: 'Today Cost',
    rpmTpm: 'RPM / TPM',
    totalRequests: 'Total Requests',
    totalInputTokens: 'Total Input',
    totalOutputTokens: 'Total Output',
    totalTokensLabel: 'Total Tokens',
    totalCacheCreation: 'Total Cache Creation',
    totalCacheRead: 'Total Cache Read',
    totalCost: 'Total Cost',
    avgDuration: 'Avg Duration',
    // Messages
    enterApiKey: 'Please enter an API Key',
    querySuccess: 'Query successful',
    queryFailed: 'Query failed',
    queryFailedRetry: 'Query failed, please try again later',
    noDailyUsage: 'No daily usage data',
  },

  // Setup Wizard
  setup: {
    title: 'Sub2API Setup',
    description: 'Configure your Sub2API instance',
    database: {
      title: 'Database Configuration',
      description: 'Connect to your PostgreSQL database',
      host: 'Host',
      port: 'Port',
      username: 'Username',
      password: 'Password',
      databaseName: 'Database Name',
      sslMode: 'SSL Mode',
      passwordPlaceholder: 'Password',
      ssl: {
        disable: 'Disable',
        require: 'Require',
        verifyCa: 'Verify CA',
        verifyFull: 'Verify Full'
      }
    },
    redis: {
      title: 'Redis Configuration',
      description: 'Connect to your Redis server',
      host: 'Host',
      port: 'Port',
      username: 'Username (optional)',
      password: 'Password (optional)',
      database: 'Database',
      usernamePlaceholder: 'Leave empty for default user',
      passwordPlaceholder: 'Password',
      enableTls: 'Enable TLS',
      enableTlsHint: 'Use TLS when connecting to Redis (public CA certs)'
    },
    admin: {
      title: 'Admin Account',
      description: 'Create your administrator account',
      email: 'Email',
      password: 'Password',
      confirmPassword: 'Confirm Password',
      passwordPlaceholder: 'Min 8 characters',
      confirmPasswordPlaceholder: 'Confirm password',
      passwordMismatch: 'Passwords do not match'
    },
    ready: {
      title: 'Ready to Install',
      description: 'Review your configuration and complete setup',
      database: 'Database',
      redis: 'Redis',
      adminEmail: 'Admin Email'
    },
    status: {
      testing: 'Testing...',
      success: 'Connection Successful',
      testConnection: 'Test Connection',
      installing: 'Installing...',
      completeInstallation: 'Complete Installation',
      completed: 'Installation completed!',
      redirecting: 'Redirecting to login page...',
      restarting: 'Service is restarting, please wait...',
      timeout: 'Service restart is taking longer than expected. Please refresh the page manually.'
    }
  },

  // Common
}
