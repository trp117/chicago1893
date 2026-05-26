// Middleware that protects admin routes
// Redirects to /admin/login if no valid session exists
export function requireAdminAuth(req, res, next) {
  if (req.session && req.session.adminUser) {
    // Valid session — attach user to request and continue
    req.adminUser = req.session.adminUser
    return next()
  }
  // No session — redirect to login
  // Store the originally requested URL so we can redirect back after login
  req.session.returnTo = req.originalUrl
  return res.redirect('/admin/login')
}
