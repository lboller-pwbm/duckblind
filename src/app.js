// Simple client-side interactivity for the private site
document.addEventListener('DOMContentLoaded', () => {
  // Highlight current nav link
  const currentPage = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('nav a').forEach(link => {
    const linkPage = link.getAttribute('href').replace('./', '').split('/').pop() || 'index.html';
    if (linkPage === currentPage) {
      link.style.background = '#16213e';
      link.style.color = '#fff';
    }
  });

  console.log('[VFS] Page loaded from encrypted DuckDB');
});
