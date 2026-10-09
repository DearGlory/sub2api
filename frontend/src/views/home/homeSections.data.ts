/**
 * Facts the home page is allowed to state.
 *
 * Every number here is read out of the platform catalogue that the backend
 * generates and validates (`platformCatalog.builtin.json`, kept in sync by
 * `TestFrontendBuiltinPlatformCatalogInSync`). Nothing is hardcoded, so the home
 * page cannot drift from what the gateway actually serves — no invented counts.
 */
import { listPlatforms } from '@/constants/platformCatalog'

export type HomeStatKey = 'platforms' | 'gateways' | 'multiProtocol' | 'traceability'

export interface HomeStatItem {
  /** Also the i18n leaf: `home.sections.stats.items.<key>`. */
  key: HomeStatKey
  value: number
  suffix: string
}

const platforms = listPlatforms()

/** Distinct inbound protocol families the gateway terminates. */
const gatewayCount = new Set(platforms.map((platform) => platform.gateway)).size

/** Platforms that carry per-protocol base URLs, i.e. pick an endpoint by inbound protocol. */
const multiProtocolCount = platforms.filter((platform) => platform.multi_protocol).length

export const HOME_STATS: HomeStatItem[] = [
  { key: 'platforms', value: platforms.length, suffix: '' },
  { key: 'gateways', value: gatewayCount, suffix: '' },
  { key: 'multiProtocol', value: multiProtocolCount, suffix: '' },
  { key: 'traceability', value: 100, suffix: '%' },
]

/** Display names straight from the catalogue — proper nouns, so they are not translated. */
export const HOME_PLATFORM_NAMES: string[] = platforms.map((platform) => platform.display_name)
