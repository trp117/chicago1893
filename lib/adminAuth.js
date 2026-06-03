// Middleware that protects admin routes
// Returns 401 JSON for API fetch calls; redirects to /admin/login for browser navigations
export function requireAdminAuth(req, res, next) {
  if (req.session && req.session.adminUser) {
    // Valid session — attach user to request and continue
    req.adminUser = req.session.adminUser
    return next()
  }
  // No session — API calls get a JSON 401; browser navigations get a redirect
  if (req.originalUrl.startsWith('/admin/api')) {
    return res.status(401).json({ error: 'Session expired' })
  }
  req.session.returnTo = req.originalUrl
  return res.redirect('/admin/login')
}
