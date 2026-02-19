import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import LoadingSpinner from '../components/LoadingSpinner'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null)

  const navigate = useNavigate()
  const location = useLocation()
  const { login, sessionExpired, setSessionExpired } = useAuthStore()

  // Get the redirect path from location state, or default to dashboard
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/dashboard'

  // Check for session expiration from location state or store
  useEffect(() => {
    const locationState = location.state as { sessionExpired?: boolean; message?: string } | null

    if (locationState?.sessionExpired || sessionExpired) {
      const message = locationState?.message || 'Your session has expired due to inactivity. Please log in again.'
      setSessionExpiredMessage(message)

      // Clear the sessionExpired flag in store after showing message
      if (sessionExpired) {
        setSessionExpired(false)
      }

      // Clear location state to prevent message showing again on refresh
      window.history.replaceState({}, document.title)
    }
  }, [location.state, sessionExpired, setSessionExpired])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Login failed')
        return
      }

      // Store user and token in auth store
      login(data.user, data.token)

      // Redirect to original destination or dashboard
      navigate(from, { replace: true })
    } catch (err) {
      console.error('Login error:', err)
      setError('An error occurred during login. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* CUI Banner Header */}
      <div className="bg-cui-bg text-cui-text text-center text-sm py-1 font-medium">
        CUI - Controlled Unclassified Information
      </div>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          {/* Logo/Title Section */}
          <div className="text-center">
            <h1 className="text-3xl font-bold text-primary-800">ACSS</h1>
            <p className="mt-2 text-sm text-gray-600">
              AirCombat Support Suite
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Military Aviation Maintenance Tracking
            </p>
          </div>

          {/* Login Form */}
          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            <div className="bg-white shadow rounded-lg p-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-6 text-center">
                Sign In
              </h2>

              {/* Session Expired Message */}
              {sessionExpiredMessage && (
                <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md" data-testid="session-expired-message">
                  <div className="flex items-center">
                    <svg className="h-5 w-5 text-yellow-600 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <p className="text-sm text-yellow-700">{sessionExpiredMessage}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              {/* Username Field */}
              <div className="mb-4">
                <label
                  htmlFor="username"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="appearance-none relative block w-full px-3 py-2 border border-gray-300 rounded-md placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder="Enter your username"
                  disabled={isLoading}
                />
              </div>

              {/* Password Field */}
              <div className="mb-6">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none relative block w-full px-3 py-2 border border-gray-300 rounded-md placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder="Enter your password"
                  disabled={isLoading}
                />
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-800 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2 text-white" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </button>

              {/* Forgot Password Link */}
              <div className="mt-4 text-center">
                <a
                  href="#"
                  className="text-sm text-primary-600 hover:text-primary-500"
                >
                  Forgot your password?
                </a>
              </div>
            </div>
          </form>

          {/* Additional Info */}
          <div className="text-center text-xs text-gray-500">
            <p>Authorized users only. All activity is monitored.</p>
          </div>
        </div>
      </main>

      {/* CUI Banner Footer - Fixed at bottom */}
      <footer className="fixed bottom-0 left-0 right-0 bg-cui-bg text-cui-text text-center text-sm py-1 font-medium z-50">
        CUI - Controlled Unclassified Information
      </footer>
    </div>
  )
}
