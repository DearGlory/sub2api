/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  // Cosmos also reaches body Teleports while html.dark retains the saved preference.
  darkMode: ['selector', ':is(.dark,[data-universe-theme="cosmos"])'],
  theme: {
    extend: {
      colors: {
        // 主色调 - 暖橙 accent（对齐 x.ai --color-sunset 22 100% 51.6%）
        // 全站唯一强调色。只用于：主按钮、当前项、焦点环、关键数字。
        primary: {
          50: '#fff4ed',
          100: '#ffe6d5',
          200: '#ffc9aa',
          300: '#ffa87a',
          400: '#ff8447',
          500: '#ff6708',
          600: '#eb5a00',
          700: '#c24a00',
          800: '#9a3b00',
          900: '#7a3000',
          950: '#431800'
        },
        // 辅助中性阶（对齐 x.ai nimbus/steel/evenfall）
        // 注意：原值为 slate 副本且全站 0 处引用，此处重定义为中性辅助阶。
        accent: {
          50: '#f8f9fa',
          100: '#f1f2f4',
          200: '#e3e5e8',
          300: '#cbd0d6',
          400: '#949aa3',
          500: '#82838a',
          600: '#5c6068',
          700: '#3a3f46',
          800: '#262a30',
          900: '#1a1d21',
          950: '#0f1113'
        },
        // 深色模式背景（x.ai jet/umbra/charcoal 谱系）
        // 数值保持不变：3130 处引用且语义正确，重定义只增加风险不增加收益。
        dark: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617'
        }
      },
      fontFamily: {
        // 对齐 x.ai：紧凑几何无衬线（xVf 的开放替身），保留中文字体栈
        sans: [
          'Inter Tight',
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif'
        ],
        // x.ai 同款等宽
        mono: [
          'Geist Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace'
        ]
      },
      // 层次靠边框与面差，不靠阴影。阴影只留给浮层，且极轻。
      // 类名全部保留（兼容既有调用方），只收平数值。
      boxShadow: {
        glass: '0 1px 2px rgba(0, 0, 0, 0.04)',
        'glass-sm': '0 1px 2px rgba(0, 0, 0, 0.03)',
        glow: 'none',
        'glow-lg': 'none',
        card: 'none',
        'card-hover': '0 1px 3px rgba(0, 0, 0, 0.06)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        // 浮层专用（弹窗 / dropdown / toast）
        pop: '0 4px 12px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06)'
      },
      backgroundImage: {
        // 全站禁用渐变装饰。保留键名（兼容调用方），值改为透明。
        'gradient-radial': 'none',
        'gradient-primary': 'none',
        'gradient-dark': 'none',
        'gradient-glass': 'none',
        'mesh-gradient': 'none'
      },
      animation: {
        'fade-in': 'fadeIn 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        'slide-up': 'slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        'slide-down': 'slideDown 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        'slide-in-right': 'slideInRight 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        'scale-in': 'scaleIn 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
        // 无装饰性动效
        'pulse-slow': 'none',
        shimmer: 'none',
        glow: 'none'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        },
        scaleIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        glow: {
          '0%': { boxShadow: 'none' },
          '100%': { boxShadow: 'none' }
        }
      },
      backdropBlur: {
        xs: '2px'
      },
      borderRadius: {
        '4xl': '2rem'
      }
    }
  },
  plugins: []
}
