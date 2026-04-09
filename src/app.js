// Simple client-side interactivity for the private site
document.addEventListener('DOMContentLoaded', () => {
  // Highlight current nav link — normalize by stripping .html and treating empty/index as home
  const normalize = (s) => (s || '').replace(/\.html$/, '').replace(/^(index)?$/, 'index');
  const currentPage = normalize(location.pathname.split('/').pop());
  document.querySelectorAll('nav a').forEach(link => {
    const linkPage = normalize(link.getAttribute('href').replace('./', '').split('/').pop());
    if (linkPage === currentPage) {
      link.style.background = '#16213e';
      link.style.color = '#fff';
    }
  });

  console.log('[VFS] Page loaded from encrypted DuckDB');
});
