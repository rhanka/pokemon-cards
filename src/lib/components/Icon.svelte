<script lang="ts">
  type IconName =
    | 'scan'
    | 'collection'
    | 'chart'
    | 'settings'
    | 'camera'
    | 'image'
    | 'shield'
    | 'search'
    | 'plus'
    | 'minus'
    | 'trash'
    | 'cloud'
    | 'download'
    | 'upload'
    | 'check'
    | 'sparkle'
    | 'wifi-off'
    | 'clock'
    | 'arrow';

  let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'scan'}
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <rect x="7.5" y="6.5" width="9" height="11" rx="1.5" />
    <path d="M10 14.5h4M10 11.5h2.5" />
  {:else if name === 'collection'}
    <path d="M6 3.5h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2Z" />
    <path d="M8 3.5v16M11 8h5M11 11h3" />
  {:else if name === 'chart'}
    <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.08V21h-4v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.52-1H3v-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.52V3h4v.08A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.52 1H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
  {:else if name === 'camera'}
    <path d="M4 7.5h3l1.4-2h7.2l1.4 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13" r="3.5" />
  {:else if name === 'image'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9" r="1.5" />
    <path d="m4 17 4.5-4 3.5 3 2.5-2 5.5 4" />
  {:else if name === 'shield'}
    <path d="M12 3 5 6v5c0 4.7 2.9 8.1 7 10 4.1-1.9 7-5.3 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  {:else if name === 'search'}
    <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'minus'}
    <path d="M5 12h14" />
  {:else if name === 'trash'}
    <path d="M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14M10 11v6M14 11v6" />
  {:else if name === 'cloud'}
    <path d="M7 18h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.5A3.3 3.3 0 0 0 7 18Z" />
  {:else if name === 'download'}
    <path d="M12 3v12m-4-4 4 4 4-4M4 20h16" />
  {:else if name === 'upload'}
    <path d="M12 16V4m-4 4 4-4 4 4M4 20h16" />
  {:else if name === 'check'}
    <path d="m5 12 4 4L19 6" />
  {:else if name === 'sparkle'}
    <path d="m12 3 1.2 4.3L17 9l-3.8 1.7L12 15l-1.2-4.3L7 9l3.8-1.7L12 3ZM18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
  {:else if name === 'wifi-off'}
    <path d="m3 3 18 18M8.5 8.5A10 10 0 0 1 20 10M5 10a10 10 0 0 1 1.5-.9M8 14a6 6 0 0 1 7.5-.5M10.5 17.5a2.3 2.3 0 0 1 3 0M12 21h.01" />
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  {:else if name === 'arrow'}
    <path d="m9 18 6-6-6-6" />
  {/if}
</svg>
