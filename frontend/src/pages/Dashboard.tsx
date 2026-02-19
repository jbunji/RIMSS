export default function Dashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Welcome to ACSS - AirCombat Support Suite
      </p>

      {/* Placeholder dashboard content */}
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Asset Status Card */}
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500">Total Assets</h3>
          <p className="mt-1 text-3xl font-semibold text-gray-900">--</p>
        </div>

        {/* PMI Due Card */}
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500">PMI Due Soon</h3>
          <p className="mt-1 text-3xl font-semibold text-warning">--</p>
        </div>

        {/* Open Jobs Card */}
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500">Open Maintenance Jobs</h3>
          <p className="mt-1 text-3xl font-semibold text-gray-900">--</p>
        </div>

        {/* Parts Awaiting Card */}
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500">Parts Awaiting</h3>
          <p className="mt-1 text-3xl font-semibold text-gray-900">--</p>
        </div>
      </div>
    </div>
  )
}
