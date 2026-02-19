import { useState, useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'
import { DocumentArrowDownIcon, CalendarIcon, PrinterIcon } from '@heroicons/react/24/outline'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface Sortie {
  sortie_id: number
  pgm_id: number
  asset_id: number
  mission_id: string
  serno: string
  ac_tailno: string | null
  sortie_date: string
  sortie_effect: string | null
  current_unit: string | null
  assigned_unit: string | null
  range: string | null
  reason: string | null
  remarks: string | null
}

interface SortieSummary {
  total_sorties: number
  fmc_count: number
  pmc_count: number
  nmcm_count: number
  nmcs_count: number
  date_range: {
    start: string
    end: string
  }
}

export default function SortieReportPage() {
  const { token, user } = useAuthStore()
  const [sorties, setSorties] = useState<Sortie[]>([])
  const [summary, setSummary] = useState<SortieSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Date range filters
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Set default date range (last 30 days)
  useEffect(() => {
    const today = new Date()
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(today.getDate() - 30)

    setEndDate(today.toISOString().split('T')[0])
    setStartDate(thirtyDaysAgo.toISOString().split('T')[0])
  }, [])

  // Fetch sorties when date range changes
  useEffect(() => {
    if (startDate && endDate) {
      fetchSortieReport()
    }
  }, [startDate, endDate])

  const fetchSortieReport = async () => {
    if (!startDate || !endDate) {
      setError('Please select both start and end dates')
      return
    }

    // Validate date range
    if (new Date(endDate) < new Date(startDate)) {
      setError('End date cannot be before start date')
      return
    }

    setLoading(true)
    setError('')

    try {
      const params = new URLSearchParams()
      params.append('start_date', startDate)
      params.append('end_date', endDate)
      params.append('limit', '1000') // Get all sorties in date range

      const url = `/api/sorties?${params.toString()}`

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch sortie report')
      }

      const data = await response.json()
      setSorties(data.sorties || [])

      // Calculate summary statistics
      const sortieList = data.sorties || []
      const summary: SortieSummary = {
        total_sorties: sortieList.length,
        fmc_count: sortieList.filter((s: Sortie) =>
          s.sortie_effect === 'FMC' || s.sortie_effect === 'Fully Mission Capable'
        ).length,
        pmc_count: sortieList.filter((s: Sortie) =>
          s.sortie_effect === 'PMC' || s.sortie_effect === 'PMCM' ||
          s.sortie_effect === 'PMCS' || s.sortie_effect === 'PMCB' ||
          s.sortie_effect === 'Partially Mission Capable' || s.sortie_effect === 'Partially Mission Capable'
        ).length,
        nmcm_count: sortieList.filter((s: Sortie) =>
          s.sortie_effect === 'NMCM' || s.sortie_effect === 'NMCB' ||
          s.sortie_effect === 'Non-Mission Capable Maintenance' ||
          s.sortie_effect === 'Non-Mission Capable'
        ).length,
        nmcs_count: sortieList.filter((s: Sortie) =>
          s.sortie_effect === 'NMCS' || s.sortie_effect === 'Non-Mission Capable Supply'
        ).length,
        date_range: {
          start: startDate,
          end: endDate,
        },
      }
      setSummary(summary)
    } catch (err) {
      console.error('Error fetching sortie report:', err)
      setError('Failed to load sortie report. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGenerateReport = () => {
    fetchSortieReport()
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

  const handlePrint = () => {
    window.print()
  }

  const exportToPDF = () => {
    if (!summary || sorties.length === 0) return

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
    doc.text('ACSS Sortie Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    if (user?.program_cd && user?.program_name) {
      doc.text(`Program: ${user.program_cd} - ${user.program_name}`, 14, 33)
    }
    const dateRangeText = `Date Range: ${formatDate(summary.date_range.start)} to ${formatDate(summary.date_range.end)}`
    doc.text(dateRangeText, 14, user?.program_cd ? 38 : 33)
    const statsText = `Total: ${summary.total_sorties} | FMC: ${summary.fmc_count} | PMC: ${summary.pmc_count} | NMCM: ${summary.nmcm_count} | NMCS: ${summary.nmcs_count}`
    doc.text(statsText, 14, user?.program_cd ? 43 : 38)

    // Prepare table data
    const tableHeaders = [
      'Mission ID',
      'Serial No',
      'Tail No',
      'Date',
      'Effect',
      'Unit',
      'Range',
      'Reason'
    ]

    const tableData = sorties.map(sortie => [
      sortie.mission_id,
      sortie.serno,
      sortie.ac_tailno || '-',
      formatDate(sortie.sortie_date),
      sortie.sortie_effect || '-',
      sortie.current_unit || '-',
      sortie.range || '-',
      sortie.reason ? sortie.reason.substring(0, 20) : '-'
    ])

    // Generate table
    const startY = user?.program_cd ? 48 : 43
    autoTable(doc, {
      head: [tableHeaders],
      body: tableData,
      startY: startY,
      margin: { left: 14, right: 14, top: 15, bottom: 15 },
      styles: {
        fontSize: 7,
        cellPadding: 1.5,
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
    const filename = `CUI-Sortie-Report-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  const exportToExcel = () => {
    if (!summary || sorties.length === 0) return

    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = ['ACSS Sortie Report']
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = user?.program_cd ? [`Program: ${user.program_cd} - ${user.program_name}`] : []
    const reportInfoRow4 = [`Date Range: ${formatDate(summary.date_range.start)} to ${formatDate(summary.date_range.end)}`]
    const reportInfoRow5 = [`Total Sorties: ${summary.total_sorties}`]
    const reportInfoRow6 = [`FMC: ${summary.fmc_count} | PMC: ${summary.pmc_count} | NMCM: ${summary.nmcm_count} | NMCS: ${summary.nmcs_count}`]

    // Table header row
    const headerRow = [
      'Mission ID',
      'Serial Number',
      'Tail Number',
      'Sortie Date',
      'Sortie Effect',
      'Current Unit',
      'Assigned Unit',
      'Range',
      'Reason',
      'Remarks'
    ]

    // Data rows
    const dataRows = sorties.map(sortie => [
      sortie.mission_id,
      sortie.serno,
      sortie.ac_tailno || '',
      formatDate(sortie.sortie_date),
      sortie.sortie_effect || '',
      sortie.current_unit || '',
      sortie.assigned_unit || '',
      sortie.range || '',
      sortie.reason || '',
      sortie.remarks || ''
    ])

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']

    // Combine all rows
    const allRows = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      ...(reportInfoRow3.length ? [reportInfoRow3] : []),
      reportInfoRow4,
      reportInfoRow5,
      reportInfoRow6,
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
      { wch: 20 },  // Mission ID
      { wch: 20 },  // Serial Number
      { wch: 15 },  // Tail Number
      { wch: 15 },  // Sortie Date
      { wch: 20 },  // Sortie Effect
      { wch: 20 },  // Current Unit
      { wch: 20 },  // Assigned Unit
      { wch: 15 },  // Range
      { wch: 30 },  // Reason
      { wch: 40 },  // Remarks
    ]

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Sortie Report')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Sortie-Report-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }

  const getEffectBadgeColor = (effect: string | null) => {
    if (!effect) return 'bg-gray-100 text-gray-800'

    if (effect === 'FMC' || effect === 'Fully Mission Capable') {
      return 'bg-green-100 text-green-800'
    }
    if (effect === 'PMC' || effect === 'PMCM' || effect === 'PMCS' || effect === 'PMCB' ||
        effect === 'Partially Mission Capable' || effect === 'Partially Mission Capable') {
      return 'bg-yellow-100 text-yellow-800'
    }
    if (effect === 'NMCM' || effect === 'NMCB' || effect.includes('Non-Mission Capable')) {
      return 'bg-orange-100 text-orange-800'
    }
    if (effect === 'NMCS' || effect === 'Non-Mission Capable Supply') {
      return 'bg-red-100 text-red-800'
    }
    return 'bg-gray-100 text-gray-800'
  }

  if (loading && !sorties.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading sortie report...</p>
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

      {/* CUI Header Banner */}
      <div className="bg-green-600 text-white text-center py-1 text-xs font-semibold mb-4">
        CUI
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Sortie Activity Report</h1>
        <p className="mt-2 text-sm text-gray-600">
          View sortie activity and effectiveness data for the selected date range.
        </p>
      </div>

      {/* Date Range Filter */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
          <CalendarIcon className="h-5 w-5 mr-2 text-gray-400" />
          Date Range
        </h2>

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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="start-date" className="block text-sm font-medium text-gray-700 mb-1">
              Start Date
            </label>
            <input
              type="date"
              id="start-date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              max={endDate || undefined}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>
          <div>
            <label htmlFor="end-date" className="block text-sm font-medium text-gray-700 mb-1">
              End Date
            </label>
            <input
              type="date"
              id="end-date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate || undefined}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleGenerateReport}
              disabled={loading || !startDate || !endDate}
              className="w-full px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Generating...' : 'Generate Report'}
            </button>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 p-4 border border-red-200">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Summary Section */}
      {summary && (
        <div className="mb-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg shadow p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">Total Sorties</div>
              <div className="text-3xl font-bold text-blue-600">{summary.total_sorties}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">FMC</div>
              <div className="text-3xl font-bold text-green-600">{summary.fmc_count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {summary.total_sorties > 0
                  ? `${((summary.fmc_count / summary.total_sorties) * 100).toFixed(1)}%`
                  : '0%'
                }
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">PMC</div>
              <div className="text-3xl font-bold text-yellow-600">{summary.pmc_count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {summary.total_sorties > 0
                  ? `${((summary.pmc_count / summary.total_sorties) * 100).toFixed(1)}%`
                  : '0%'
                }
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">NMCM</div>
              <div className="text-3xl font-bold text-orange-600">{summary.nmcm_count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {summary.total_sorties > 0
                  ? `${((summary.nmcm_count / summary.total_sorties) * 100).toFixed(1)}%`
                  : '0%'
                }
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">NMCS</div>
              <div className="text-3xl font-bold text-red-600">{summary.nmcs_count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {summary.total_sorties > 0
                  ? `${((summary.nmcs_count / summary.total_sorties) * 100).toFixed(1)}%`
                  : '0%'
                }
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sorties Table */}
      {sorties.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h2 className="text-lg font-semibold text-gray-900">
              Sortie Details ({sorties.length} sorties)
            </h2>
            <div className="flex items-center space-x-2 no-print">
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 text-sm"
                title="Print Report"
              >
                <PrinterIcon className="h-4 w-4" />
                Print
              </button>
              <button
                onClick={exportToPDF}
                className="flex items-center gap-2 px-3 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 text-sm"
                title="Export to PDF"
              >
                <DocumentArrowDownIcon className="h-4 w-4" />
                Export PDF
              </button>
              <button
                onClick={exportToExcel}
                className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 text-sm"
                title="Export to Excel"
              >
                <DocumentArrowDownIcon className="h-4 w-4" />
                Export Excel
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Mission ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Asset S/N
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tail Number
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Effectiveness
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Range
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Unit
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {sorties.map((sortie) => (
                  <tr key={sortie.sortie_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {sortie.mission_id}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {sortie.serno}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {sortie.ac_tailno || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {formatDate(sortie.sortie_date)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {sortie.sortie_effect ? (
                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getEffectBadgeColor(sortie.sortie_effect)}`}>
                          {sortie.sortie_effect}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {sortie.range || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {sortie.current_unit || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No Sorties Message */}
      {!loading && sorties.length === 0 && summary && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-500">
            No sorties found for the selected date range.
          </p>
          <p className="text-sm text-gray-400 mt-2">
            Try selecting a different date range.
          </p>
        </div>
      )}

      {/* CUI Footer Banner */}
      <div className="bg-green-600 text-white text-center py-1 text-xs font-semibold mt-6">
        CUI
      </div>

      {/* Print-only CUI Footer */}
      <div className="print-only print-cui-footer print-footer" style={{ display: 'none' }}>
        CUI - CONTROLLED UNCLASSIFIED INFORMATION
      </div>
    </div>
  )
}
