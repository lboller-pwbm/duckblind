// Simple client-side interactivity for the private site
document.addEventListener('DOMContentLoaded', () => {
  // Highlight current nav link
  const currentPath = window.location.hash.replace('#', '') || '/';
  document.querySelectorAll('nav a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (currentPath === '/' && href === '/')) {
      link.style.background = '#16213e';
      link.style.color = '#fff';
    }
  });

  console.log('[VFS] Page loaded from encrypted DuckDB');
});
