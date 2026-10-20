<template>
  <ChannelStatusV1View v-if="isV1" />
  <ChannelStatusV2View v-else-if="isLegacyV2" />
  <ChannelStatusV3View v-else />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isChannelMonitorV1Mode, isChannelMonitorPassiveMode } from '@/utils/featureFlags'
import ChannelStatusV1View from './ChannelStatusV1View.vue'
import ChannelStatusV2View from './ChannelStatusV2View.vue'
import ChannelStatusV3View from './ChannelStatusV3View.vue'

const isV1 = computed(() => isChannelMonitorV1Mode())
// Keep the plain V2 view reachable as a rollback/diagnostic surface without
// adding another backend flag: ?monitor_view=v2. Works under v2 and v3 (hybrid),
// since both ride the passive stack.
const isLegacyV2 = computed(() => isChannelMonitorPassiveMode() &&
  new URLSearchParams(window.location.search).get('monitor_view') === 'v2')
</script>
