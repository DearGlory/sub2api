import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en/misc'
import zh from '@/i18n/locales/zh/misc'

describe('EPUSDT settlement policy copy', () => {
  it('does not contradict automatic credit by requiring manual review for missing network proof', () => {
    expect(zh.payment.epusdtNetworkHint).toContain('EPUSDT 收银台选择网络')
    expect(zh.payment.epusdtNetworkHint).toContain('本站无需选择网络')
    expect(zh.payment.epusdtAutoSettlementHint).toContain('自动入账')
    expect(en.payment.epusdtAutoSettlementHint).toContain('automatically')
    expect(zh.payment.epusdtNetworkHint).not.toContain('无法核实实际结算网络的付款会进入人工核对')
    expect(en.payment.epusdtNetworkHint).not.toContain('cannot be verified are sent for manual review')
  })
})
