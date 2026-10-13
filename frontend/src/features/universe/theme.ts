/** Read the rendered surface theme without changing the user's theme preference. */
export function isDarkSurface(): boolean {
  return typeof document !== 'undefined' && (
    document.documentElement.dataset.universeTheme === 'cosmos' ||
    document.documentElement.classList.contains('dark')
  )
}
