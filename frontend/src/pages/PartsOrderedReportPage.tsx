import { useState, useEffect } from 'react'
import {
  ShoppingCartIcon,
  DocumentArrowDownIcon,
  ExclamationTriangleIcon,
  PrinterIcon,
} from '@heroicons/react/24/outline'
import { useAuthStore } from '../stores/authStore'
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

// Summary statistics interface
interface OrdersSummary {
  totalOrders: number
  byStatus: {
    pending: number
    acknowledged: number
    shipped: number
    received: number
    cancelled: number
  }
  byPriority: {
    routine: number
    urgent: number
    critical: number
  }
  pqdrCount: number
  totalValue: number
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

export default function PartsOrderedReportPage() {
  const { token, currentProgramId, user } = useAuthStore()

  // State
  const [orders, setOrders] = useState<PartsOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<OrdersSummary | null>(null)

  // Date range state
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')

  // Calculate summary statistics
  const calculateSummary = (ordersList: PartsOrder[]): OrdersSummary => {
    const summary: OrdersSummary = {
      totalOrders: ordersList.length,
      byStatus: {
        pending: 0,
        acknowledged: 0,
        shipped: 0,
        received: 0,
        cancelled: 0,
      },
      byPriority: {
        routine: 0,
        urgent: 0,
        critical: 0,
      },
      pqdrCount: 0,
      totalValue: 0,
    }

    ordersList.forEach(order => {
      summary.byStatus[order.status]++
      summary.byPriority[order.priority]++
      if (order.pqdr) summary.pqdrCount++
      summary.totalValue += order.unit_price * order.qty_ordered
    })

    return summary
  }

  // Fetch parts orders for the report
  const fetchOrders = async () => {
    if (!token || !currentProgramId) return

    // Validate date range if both dates are provided
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      setError('End date cannot be before start date')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        page: '1',
        limit: '10000', // Get all orders for report
      })

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
      setSummary(calculateSummary(data.orders))
    } catch (err) {
      console.error('Error fetching parts orders:', err)
      setError('Failed to load parts orders. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Quick filter functions
  const setTodayFilter = () => {
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]
    setStartDate(todayStr)
    setEndDate(todayStr)
  }

  const setThisWeekFilter = () => {
    const today = new Date()
    const dayOfWeek = today.getDay() // 0 (Sunday) to 6 (Saturday)

    // Calculate start of week (Sunday)
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() - dayOfWeek)

    // End of week is today (or Saturday if you want full week)
    const endOfWeek = new Date(today)

    setStartDate(startOfWeek.toISOString().split('T')[0])
    setEndDate(endOfWeek.toISOString().split('T')[0])
  }

  // Generate report on mount and when date range changes
  useEffect(() => {
    if (token && currentProgramId) {
      fetchOrders()
    }
  }, [token, currentProgramId, startDate, endDate])

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

  // Handle print
  const handlePrint = () => {
    window.print()
  }

  // Export to PDF with CUI markings
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
      doc.setFillColor(254, 243, 199) // #FEF3C7
      doc.rect(0, 0, pageWidth, 12, 'F')
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0, 0, 0)
      doc.text(cuiHeaderText, pageWidth / 2, 7, { align: 'center' })
    }

    // Add CUI footer function
    const addCuiFooter = (pageNum: number, totalPages: number) => {
      doc.setFillColor(254, 243, 199) // #FEF3C7
      doc.rect(0, pageHeight - 12, pageWidth, 12, 'F')
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0, 0, 0)
      doc.text(cuiFooterText, pageWidth / 2, pageHeight - 5, { align: 'center' })
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
    doc.text('ACSS Parts Ordered Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    doc.text(`Total Orders: ${orders.length}`, 14, 33)
    if (user?.program_cd && user?.program_name) {
      doc.text(`Program: ${user.program_cd} - ${user.program_name}`, 14, 38)
    }

    // Date range if specified
    let yPos = user?.program_cd ? 43 : 38
    if (startDate && endDate) {
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      doc.text(`Date Range: ${startDate} to ${endDate}`, 14, yPos)
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

    const tableData = orders.map(order => [
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
        addCuiFooter(currentPage, pageCount)
      },
    })

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Parts-Ordered-Report-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export to Excel with CUI markings
  const exportToExcel = () => {
    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = ['ACSS Parts Ordered Report']
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Total Orders: ${orders.length}`]
    const reportInfoRow4 = user?.program_cd ? [`Program: ${user.program_cd} - ${user.program_name}`] : []

    // Date range if specified
    const dateRangeRow = startDate && endDate ? [`Date Range: ${startDate} to ${endDate}`] : []

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
    const dataRows = orders.map(order => [
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
      ...(dateRangeRow.length ? [dateRangeRow] : []),
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

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Parts Orders')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Parts-Ordered-Report-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Generating parts ordered report...</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Print-only CUI Header */}
      <div className="print-only print-cui-header" style={{ display: 'none' }}>
        CONTROLLED UNCLASSIFIED INFORMATION (CUI)
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center">
              <ShoppingCartIcon className="h-8 w-8 text-primary-600 mr-3" />
              Parts Ordered Report
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              Comprehensive parts requisition status report
            </p>
          </div>
          <div className="flex items-center space-x-2 no-print">
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              title="Print Report"
            >
              <PrinterIcon className="h-5 w-5" />
              Print
            </button>
            <button
              onClick={exportToPDF}
              disabled={orders.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Export to PDF"
            >
              <DocumentArrowDownIcon className="h-5 w-5" />
              Export PDF
            </button>
            <button
              onClick={exportToExcel}
              disabled={orders.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Export to Excel"
            >
              <DocumentArrowDownIcon className="h-5 w-5" />
              Export Excel
            </button>
          </div>
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="mb-6 bg-white p-4 rounded-lg shadow border border-gray-200">
        {/* Quick Filters */}
        <div className="mb-4 flex gap-2">
          <button
            onClick={setTodayFilter}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-sm font-medium transition-colors"
          >
            Today
          </button>
          <button
            onClick={setThisWeekFilter}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-sm font-medium transition-colors"
          >
            This Week
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              max={endDate || undefined}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate || undefined}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Summary Statistics */}
      {summary && (
        <div className="mb-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {/* Total Orders */}
          <div className="bg-white overflow-hidden shadow rounded-lg border border-gray-200">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <ShoppingCartIcon className="h-8 w-8 text-blue-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Orders</dt>
                    <dd className="text-2xl font-semibold text-gray-900">{summary.totalOrders}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          {/* PQDR Orders */}
          <div className="bg-white overflow-hidden shadow rounded-lg border border-red-200">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <ExclamationTriangleIcon className="h-8 w-8 text-red-600" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">PQDR Orders</dt>
                    <dd className="text-2xl font-semibold text-red-600">{summary.pqdrCount}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          {/* Pending Orders */}
          <div className="bg-white overflow-hidden shadow rounded-lg border border-yellow-200">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="h-8 w-8 rounded-full bg-yellow-100 flex items-center justify-center">
                    <span className="text-yellow-600 font-bold text-sm">P</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Pending</dt>
                    <dd className="text-2xl font-semibold text-yellow-600">{summary.byStatus.pending}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          {/* Total Value */}
          <div className="bg-white overflow-hidden shadow rounded-lg border border-green-200">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center">
                    <span className="text-green-600 font-bold text-sm">$</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Value</dt>
                    <dd className="text-2xl font-semibold text-green-600">{formatCurrency(summary.totalValue)}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status Breakdown */}
      {summary && (
        <div className="mb-6 bg-white p-4 rounded-lg shadow border border-gray-200">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Status Breakdown</h3>
          <div className="flex flex-wrap gap-2">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors.pending.bg} ${statusColors.pending.text}`}>
              Pending: {summary.byStatus.pending}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors.acknowledged.bg} ${statusColors.acknowledged.text}`}>
              Acknowledged: {summary.byStatus.acknowledged}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors.shipped.bg} ${statusColors.shipped.text}`}>
              Shipped: {summary.byStatus.shipped}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors.received.bg} ${statusColors.received.text}`}>
              Received: {summary.byStatus.received}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors.cancelled.bg} ${statusColors.cancelled.text}`}>
              Cancelled: {summary.byStatus.cancelled}
            </span>
          </div>

          <h3 className="text-sm font-medium text-gray-700 mb-3 mt-4">Priority Breakdown</h3>
          <div className="flex flex-wrap gap-2">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${priorityColors.routine.bg} ${priorityColors.routine.text}`}>
              Routine: {summary.byPriority.routine}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${priorityColors.urgent.bg} ${priorityColors.urgent.text}`}>
              Urgent: {summary.byPriority.urgent}
            </span>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${priorityColors.critical.bg} ${priorityColors.critical.text}`}>
              Critical: {summary.byPriority.critical}
            </span>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white shadow rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Order Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Part Number
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Part Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Qty
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Priority
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
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    No parts orders found for the selected date range.
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr
                    key={order.order_id}
                    className={`${order.pqdr ? 'bg-red-50' : ''} hover:bg-gray-50 transition-colors`}
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
      </div>

      {/* Print-only CUI Footer */}
      <div className="print-only print-cui-footer print-footer" style={{ display: 'none' }}>
        CUI - CONTROLLED UNCLASSIFIED INFORMATION
      </div>
    </div>
  )
}
