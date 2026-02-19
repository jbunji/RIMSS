import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShoppingCartIcon,
  MagnifyingGlassIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronUpDownIcon,
  FunnelIcon,
  XMarkIcon,
  ExclamationTriangleIcon,
  DocumentArrowDownIcon,
} from '@heroicons/react/24/outline'
import { useAuthStore } from '../stores/authStore'
import { SkeletonTable } from '../components/skeleton'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// Parts order interface matching backend
interface PartsOrder {
  order_id: number
  part_no: string
  part_name: string
  nsn: string
  qty_ordered: number
  qty_received: number
  unit_price: number
  order_date: string
  request_date: string
  status: 'pending' | 'acknowledged' | 'shipped' | 'received' | 'cancelled'
  requestor_id: number
  requestor_name: string
  asset_sn: string | null
  asset_name: string | null
  job_no: string | null
  priority: 'routine' | 'urgent' | 'critical'
  pgm_id: number
  notes: string
  shipping_tracking: string | null
  estimated_delivery: string | null
  program_cd: string
  program_name: string
  pqdr: boolean
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

// Status badge colors
const statusColors: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  acknowledged: { bg: 'bg-blue-100', text: 'text-blue-800' },
  shipped: { bg: 'bg-purple-100', text: 'text-purple-800' },
  received: { bg: 'bg-green-100', text: 'text-green-800' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-800' },
}

// Priority badge colors
const priorityColors: Record<string, { bg: string; text: string }> = {
  routine: { bg: 'bg-gray-100', text: 'text-gray-800' },
  urgent: { bg: 'bg-orange-100', text: 'text-orange-800' },
  critical: { bg: 'bg-red-100', text: 'text-red-800' },
}

type SortField = 'order_date' | 'part_no' | 'status' | 'priority' | 'qty_ordered'
type SortDirection = 'asc' | 'desc'

export default function PartsOrderedPage() {
  const navigate = useNavigate()
  const { token, currentProgramId, user } = useAuthStore()

  // State
  const [orders, setOrders] = useState<PartsOrder[]>([])
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [priorityFilter, setPriorityFilter] = useState<string>('')
  const [pqdrFilter, setPqdrFilter] = useState(false)
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [showFilters, setShowFilters] = useState(false)

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('order_date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Fetch parts orders
  const fetchOrders = async () => {
    if (!token || !currentProgramId) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      })

      if (searchQuery) params.append('search', searchQuery)
      if (statusFilter) params.append('status', statusFilter)
      if (priorityFilter) params.append('priority', priorityFilter)
      if (pqdrFilter) params.append('pqdr', 'true')
      if (startDate) params.append('start_date', startDate)
      if (endDate) params.append('end_date', endDate)

      const response = await fetch(`/api/parts-orders?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch parts orders')
      }

      const data = await response.json()
      setOrders(data.orders)
      setPagination({
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      })
    } catch (err) {
      console.error('Error fetching parts orders:', err)
      setError('Failed to load parts orders. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Fetch on mount and when dependencies change
  useEffect(() => {
    fetchOrders()
  }, [token, currentProgramId, pagination.page, searchQuery, statusFilter, priorityFilter, pqdrFilter, startDate, endDate])

  // Handle search
  const handleSearch = (value: string) => {
    setSearchQuery(value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Handle filter changes
  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  const handlePriorityFilterChange = (value: string) => {
    setPriorityFilter(value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  const handleClearFilters = () => {
    setSearchQuery('')
    setStatusFilter('')
    setPriorityFilter('')
    setPqdrFilter(false)
    setStartDate('')
    setEndDate('')
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Handle sort
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  // Helper function to get ZULU timestamp
  const getZuluTimestamp = (): string => {
    const now = new Date()
    return now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
  }

  // Helper function to get ZULU date for filename
  const getZuluDateForFilename = (): string => {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    return `${year}${month}${day}`
  }

  // Export parts orders to PDF with CUI markings
  const exportToPDF = () => {
    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4'
    })

    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const zuluTimestamp = getZuluTimestamp()

    // CUI Banner text
    const cuiHeaderText = 'CONTROLLED UNCLASSIFIED INFORMATION (CUI)'
    const cuiFooterText = 'CUI - CONTROLLED UNCLASSIFIED INFORMATION'

    // Add CUI header function
    const addCuiHeader = () => {
      // Yellow background for CUI banner
      doc.setFillColor(254, 243, 199) // #FEF3C7
      doc.rect(0, 0, pageWidth, 12, 'F')

      // CUI text
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0, 0, 0)
      doc.text(cuiHeaderText, pageWidth / 2, 7, { align: 'center' })
    }

    // Add CUI footer function
    const addCuiFooter = (pageNum: number, totalPages: number) => {
      // Yellow background for CUI footer banner
      doc.setFillColor(254, 243, 199) // #FEF3C7
      doc.rect(0, pageHeight - 12, pageWidth, 12, 'F')

      // CUI text
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0, 0, 0)
      doc.text(cuiFooterText, pageWidth / 2, pageHeight - 5, { align: 'center' })

      // Page number on footer
      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - 15, pageHeight - 5, { align: 'right' })
    }

    // Add header
    addCuiHeader()

    // Title
    doc.setFontSize(16)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text('ACSS Parts Orders Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    doc.text(`Total Orders: ${orders.length}`, 14, 33)
    if (user?.program_cd && user?.program_name) {
      doc.text(`Program: ${user.program_cd} - ${user.program_name}`, 14, 38)
    }

    // Filters info
    let yPos = user?.program_cd ? 43 : 38
    const hasActiveFilters = searchQuery || statusFilter || priorityFilter || pqdrFilter || startDate || endDate
    if (hasActiveFilters) {
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      const filters: string[] = []
      if (searchQuery) filters.push(`Search: "${searchQuery}"`)
      if (statusFilter) filters.push(`Status: ${statusFilter}`)
      if (priorityFilter) filters.push(`Priority: ${priorityFilter}`)
      if (pqdrFilter) filters.push('PQDR Only')
      if (startDate && endDate) filters.push(`Date Range: ${startDate} to ${endDate}`)
      doc.text(`Filters: ${filters.join(', ')}`, 14, yPos)
      yPos += 5
    }

    // Prepare table data
    const tableHeaders = [
      'Order Date',
      'Part Number',
      'Part Name',
      'Qty',
      'Status',
      'Priority',
      'Requestor',
      'Asset S/N'
    ]

    const tableData = sortedOrders.map(order => [
      formatDate(order.order_date),
      order.part_no,
      order.part_name.substring(0, 30), // Truncate for space
      order.qty_ordered.toString(),
      order.status.charAt(0).toUpperCase() + order.status.slice(1),
      order.priority.charAt(0).toUpperCase() + order.priority.slice(1),
      order.requestor_name,
      order.asset_sn || '-'
    ])

    // Generate table
    autoTable(doc, {
      head: [tableHeaders],
      body: tableData,
      startY: yPos + 5,
      margin: { left: 14, right: 14, top: 15, bottom: 15 },
      styles: {
        fontSize: 8,
        cellPadding: 2,
      },
      headStyles: {
        fillColor: [59, 130, 246], // primary-600
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251], // gray-50
      },
      didDrawPage: (data: any) => {
        const pageCount = (doc as any).internal.pages.length - 1
        const currentPage = (doc as any).internal.getCurrentPageInfo().pageNumber

        // Add CUI footer to each page
        addCuiFooter(currentPage, pageCount)
      },
    })

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Parts-Orders-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export parts orders to Excel with CUI markings
  const exportToExcel = () => {
    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = ['ACSS Parts Orders Report']
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Total Orders: ${orders.length}`]
    const reportInfoRow4 = user?.program_cd ? [`Program: ${user.program_cd} - ${user.program_name}`] : []

    // Filter info
    const filters: string[] = []
    if (searchQuery) filters.push(`Search: "${searchQuery}"`)
    if (statusFilter) filters.push(`Status: ${statusFilter}`)
    if (priorityFilter) filters.push(`Priority: ${priorityFilter}`)
    if (pqdrFilter) filters.push('PQDR Only')
    if (startDate && endDate) filters.push(`Date Range: ${startDate} to ${endDate}`)
    const filterRow = filters.length > 0 ? [`Filters: ${filters.join(', ')}`] : []

    // Table header row
    const headerRow = [
      'Order ID',
      'Order Date',
      'Request Date',
      'Part Number',
      'Part Name',
      'NSN',
      'Qty Ordered',
      'Qty Received',
      'Unit Price',
      'Status',
      'Priority',
      'Requestor',
      'Asset S/N',
      'Asset Name',
      'Job No',
      'Tracking Number',
      'Est. Delivery',
      'PQDR',
      'Notes'
    ]

    // Data rows
    const dataRows = sortedOrders.map(order => [
      order.order_id.toString(),
      formatDate(order.order_date),
      formatDate(order.request_date),
      order.part_no,
      order.part_name,
      order.nsn || '',
      order.qty_ordered.toString(),
      order.qty_received.toString(),
      formatCurrency(order.unit_price),
      order.status.charAt(0).toUpperCase() + order.status.slice(1),
      order.priority.charAt(0).toUpperCase() + order.priority.slice(1),
      order.requestor_name,
      order.asset_sn || '',
      order.asset_name || '',
      order.job_no || '',
      order.shipping_tracking || '',
      order.estimated_delivery ? formatDate(order.estimated_delivery) : '',
      order.pqdr ? 'Yes' : 'No',
      order.notes || ''
    ])

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']

    // Combine all rows
    const allRows = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      reportInfoRow3,
      ...(reportInfoRow4.length ? [reportInfoRow4] : []),
      ...(filterRow.length ? [filterRow] : []),
      blankRow,
      headerRow,
      ...dataRows,
      blankRow,
      cuiFooterRow
    ]

    // Create worksheet from array of arrays
    const ws = XLSX.utils.aoa_to_sheet(allRows)

    // Set column widths
    ws['!cols'] = [
      { wch: 10 },  // Order ID
      { wch: 12 },  // Order Date
      { wch: 12 },  // Request Date
      { wch: 18 },  // Part Number
      { wch: 30 },  // Part Name
      { wch: 15 },  // NSN
      { wch: 12 },  // Qty Ordered
      { wch: 12 },  // Qty Received
      { wch: 12 },  // Unit Price
      { wch: 12 },  // Status
      { wch: 12 },  // Priority
      { wch: 20 },  // Requestor
      { wch: 15 },  // Asset S/N
      { wch: 25 },  // Asset Name
      { wch: 12 },  // Job No
      { wch: 20 },  // Tracking Number
      { wch: 12 },  // Est. Delivery
      { wch: 8 },   // PQDR
      { wch: 40 },  // Notes
    ]

    // Merge CUI header cells across all columns
    const numCols = headerRow.length
    const headerRowIdx = reportInfoRow4.length ? 8 : 7
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
      { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
      { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
      { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Total orders
    ]

    // Add program row merge if present
    if (reportInfoRow4.length) {
      ws['!merges'].push({ s: { r: 5, c: 0 }, e: { r: 5, c: numCols - 1 } })
    }

    // Add filters row merge if present
    if (filterRow.length) {
      const filterRowIdx = reportInfoRow4.length ? 6 : 5
      ws['!merges'].push({ s: { r: filterRowIdx, c: 0 }, e: { r: filterRowIdx, c: numCols - 1 } })
    }

    // Add footer merge
    const footerRowIdx = allRows.length - 1
    ws['!merges'].push({ s: { r: footerRowIdx, c: 0 }, e: { r: footerRowIdx, c: numCols - 1 } })

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Parts Orders')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Parts-Orders-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  // Sort orders client-side
  const sortedOrders = [...orders].sort((a, b) => {
    let aVal: any = a[sortField]
    let bVal: any = b[sortField]

    if (sortField === 'order_date') {
      aVal = new Date(aVal).getTime()
      bVal = new Date(bVal).getTime()
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1
    return 0
  })

  // Handle row click
  const handleRowClick = (orderId: number) => {
    navigate(`/parts-orders/${orderId}`)
  }

  // Format currency
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount)
  }

  // Format date
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  // Render sort icon
  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ChevronUpDownIcon className="h-4 w-4 text-gray-400" />
    }
    return sortDirection === 'asc' ? (
      <ChevronUpIcon className="h-4 w-4 text-primary-600" />
    ) : (
      <ChevronDownIcon className="h-4 w-4 text-primary-600" />
    )
  }

  if (loading && orders.length === 0) {
    return (
      <div className="p-6">
        <SkeletonTable rows={10} columns={8} showHeader={true} />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center">
              <ShoppingCartIcon className="h-8 w-8 text-primary-600 mr-3" />
              Parts Ordered
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {pagination.total} {pagination.total === 1 ? 'order' : 'orders'} found
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={exportToPDF}
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
              title="Export to PDF"
            >
              <DocumentArrowDownIcon className="h-5 w-5" />
              Export PDF
            </button>
            <button
              onClick={exportToExcel}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
              title="Export to Excel"
            >
              <DocumentArrowDownIcon className="h-5 w-5" />
              Export Excel
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 bg-white p-4 rounded-lg shadow border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            <FunnelIcon className="h-5 w-5 mr-2" />
            {showFilters ? 'Hide' : 'Show'} Filters
          </button>
          {(searchQuery || statusFilter || priorityFilter || pqdrFilter || startDate || endDate) && (
            <button
              onClick={handleClearFilters}
              className="flex items-center text-sm text-gray-600 hover:text-gray-900"
            >
              <XMarkIcon className="h-4 w-4 mr-1" />
              Clear All
            </button>
          )}
        </div>

        {showFilters && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Search */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Search
                </label>
                <div className="relative">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="Document #, Part #, NSN, Serial..."
                    className="pl-10 w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                  />
                </div>
              </div>

              {/* Status Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => handleStatusFilterChange(e.target.value)}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                >
                  <option value="">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="acknowledged">Acknowledged</option>
                  <option value="shipped">Shipped</option>
                  <option value="received">Received</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              {/* Priority Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Priority
                </label>
                <select
                  value={priorityFilter}
                  onChange={(e) => handlePriorityFilterChange(e.target.value)}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                >
                  <option value="">All Priorities</option>
                  <option value="routine">Routine</option>
                  <option value="urgent">Urgent</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Start Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Start Date
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value)
                    setPagination(prev => ({ ...prev, page: 1 }))
                  }}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                />
              </div>

              {/* End Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  End Date
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value)
                    setPagination(prev => ({ ...prev, page: 1 }))
                  }}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                />
              </div>

              {/* PQDR Filter */}
              <div>
                <label className="flex items-center cursor-pointer mt-6">
                  <input
                    type="checkbox"
                    checked={pqdrFilter}
                    onChange={(e) => {
                      setPqdrFilter(e.target.checked)
                      setPagination(prev => ({ ...prev, page: 1 }))
                    }}
                    className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                  />
                  <ExclamationTriangleIcon className="h-5 w-5 ml-2 mr-1 text-red-500" />
                  <span className="text-sm font-medium text-gray-700">
                    PQDR Only
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="bg-white shadow rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort('order_date')}
                >
                  <div className="flex items-center">
                    Order Date
                    {renderSortIcon('order_date')}
                  </div>
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort('part_no')}
                >
                  <div className="flex items-center">
                    Part Number
                    {renderSortIcon('part_no')}
                  </div>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Part Name
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort('qty_ordered')}
                >
                  <div className="flex items-center">
                    Qty
                    {renderSortIcon('qty_ordered')}
                  </div>
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort('status')}
                >
                  <div className="flex items-center">
                    Status
                    {renderSortIcon('status')}
                  </div>
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort('priority')}
                >
                  <div className="flex items-center">
                    Priority
                    {renderSortIcon('priority')}
                  </div>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Requestor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Asset
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    No parts orders found. Try adjusting your filters.
                  </td>
                </tr>
              ) : (
                sortedOrders.map((order) => (
                  <tr
                    key={order.order_id}
                    onClick={() => handleRowClick(order.order_id)}
                    className={`cursor-pointer ${order.pqdr ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <div className="flex items-center space-x-2">
                        <span>{formatDate(order.order_date)}</span>
                        {order.pqdr && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-500 text-white" title="Product Quality Deficiency Report">
                            PQDR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{order.part_no}</div>
                      <div className="text-xs text-gray-500">{order.nsn}</div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {order.part_name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {order.qty_ordered}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          statusColors[order.status]?.bg || 'bg-gray-100'
                        } ${statusColors[order.status]?.text || 'text-gray-800'}`}
                      >
                        {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          priorityColors[order.priority]?.bg || 'bg-gray-100'
                        } ${priorityColors[order.priority]?.text || 'text-gray-800'}`}
                      >
                        {order.priority.charAt(0).toUpperCase() + order.priority.slice(1)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {order.requestor_name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {order.asset_sn || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
            <div className="flex-1 flex justify-between sm:hidden">
              <button
                onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                disabled={pagination.page === 1}
                className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                disabled={pagination.page === pagination.totalPages}
                className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  Showing{' '}
                  <span className="font-medium">
                    {(pagination.page - 1) * pagination.limit + 1}
                  </span>{' '}
                  to{' '}
                  <span className="font-medium">
                    {Math.min(pagination.page * pagination.limit, pagination.total)}
                  </span>{' '}
                  of <span className="font-medium">{pagination.total}</span> results
                </p>
              </div>
              <div>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                    disabled={pagination.page === 1}
                    className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                    disabled={pagination.page === pagination.totalPages}
                    className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
