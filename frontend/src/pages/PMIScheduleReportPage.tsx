import { useEffect, useState } from 'react'
import { CalendarDaysIcon, ExclamationTriangleIcon, ClockIcon, CheckCircleIcon, DocumentArrowDownIcon, PrinterIcon } from '@heroicons/react/24/outline'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface PMI {
  pmi_id: number
  asset_id: number
  asset_sn: string
  asset_name: string
  pmi_type: string
  wuc_cd: string
  next_due_date: string
  days_until_due: number
  completed_date: string | null
  pgm_id: number
  status: 'overdue' | 'due_soon' | 'upcoming' | 'completed'
  interval_days: number
}

interface ReportData {
  program: {
    pgm_id: number
    name: string
    description: string
  } | null
  programs: Array<{
    pgm_id: number
    name: string
    description: string
  }>
  total: number
  by_status: {
    overdue: number
    due_soon: number
    upcoming: number
    completed: number
  }
  pmis: PMI[]
  grouped_by_status: {
    overdue: PMI[]
    due_soon: PMI[]
    upcoming: PMI[]
    completed: PMI[]
  }
  generated_at: string
}

export default function PMIScheduleReportPage() {
  const [reportData, setReportData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState({
    overdue: true,
    due_soon: true,
    upcoming: true,
    completed: false, // Collapsed by default
  })

  useEffect(() => {
    fetchReport()
  }, [])

  const fetchReport = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/reports/pmi-schedule', {
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error('Failed to fetch PMI schedule report')
      }

      const data = await response.json()
      setReportData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const getStatusBadge = (status: PMI['status']) => {
    const badges = {
      overdue: 'bg-red-100 text-red-800 border-red-200',
      due_soon: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      upcoming: 'bg-green-100 text-green-800 border-green-200',
      completed: 'bg-gray-100 text-gray-800 border-gray-200',
    }
    const labels = {
      overdue: 'OVERDUE',
      due_soon: 'DUE SOON',
      upcoming: 'UPCOMING',
      completed: 'COMPLETED',
    }
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${badges[status]}`}>
        {labels[status]}
      </span>
    )
  }

  const getDaysUntilDueBadge = (days: number) => {
    if (days < 0) {
      return (
        <span className="text-red-600 font-semibold">
          {Math.abs(days)} days overdue
        </span>
      )
    } else if (days === 0) {
      return <span className="text-red-600 font-semibold">Due today</span>
    } else if (days <= 7) {
      return <span className="text-yellow-600 font-semibold">{days} days</span>
    } else {
      return <span className="text-gray-600">{days} days</span>
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

  const handlePrint = () => {
    window.print()
  }

  const handleExportToPDF = () => {
    if (!reportData) return

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
    doc.text('ACSS PMI Schedule Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    if (reportData.program) {
      doc.text(`Program: ${reportData.program.name}`, 14, 33)
    }
    const statsText = `Total: ${reportData.total} | Overdue: ${reportData.by_status.overdue} | Due Soon: ${reportData.by_status.due_soon} | Upcoming: ${reportData.by_status.upcoming} | Completed: ${reportData.by_status.completed}`
    doc.text(statsText, 14, reportData.program ? 38 : 33)

    let yPos = reportData.program ? 43 : 38

    // Add each status section
    const sections: Array<{ title: string; pmis: PMI[]; color: number[] }> = [
      { title: 'OVERDUE PMIs', pmis: reportData.grouped_by_status.overdue, color: [220, 38, 38] },
      { title: 'DUE SOON - Within 7 Days', pmis: reportData.grouped_by_status.due_soon, color: [245, 158, 11] },
      { title: 'UPCOMING PMIs', pmis: reportData.grouped_by_status.upcoming, color: [22, 163, 74] },
      { title: 'COMPLETED PMIs', pmis: reportData.grouped_by_status.completed, color: [107, 114, 128] }
    ]

    sections.forEach((section, index) => {
      if (section.pmis.length > 0) {
        // Check if we need a new page
        if (yPos > pageHeight - 40) {
          doc.addPage()
          addCuiHeader()
          yPos = 18
        }

        // Section header
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(section.color[0], section.color[1], section.color[2])
        doc.text(`${section.title} (${section.pmis.length})`, 14, yPos)
        doc.setTextColor(0, 0, 0)
        yPos += 6

        // Table headers
        const tableHeaders = ['Asset S/N', 'Asset Name', 'PMI Type', 'WUC', 'Next Due', 'Days Until', 'Status']

        const tableData = section.pmis.map(pmi => [
          pmi.asset_sn,
          pmi.asset_name ? pmi.asset_name.substring(0, 20) : '',
          pmi.pmi_type.substring(0, 25),
          pmi.wuc_cd || '',
          formatDate(pmi.next_due_date),
          pmi.days_until_due.toString(),
          pmi.status.toUpperCase().replace('_', ' ')
        ])

        autoTable(doc, {
          head: [tableHeaders],
          body: tableData,
          startY: yPos,
          margin: { left: 14, right: 14 },
          styles: {
            fontSize: 7,
            cellPadding: 1.5,
          },
          headStyles: {
            fillColor: section.color,
            textColor: [255, 255, 255],
            fontStyle: 'bold',
          },
          alternateRowStyles: {
            fillColor: [249, 250, 251],
          },
          didDrawPage: (data: any) => {
            const pageCount = (doc as any).internal.pages.length - 1
            const currentPage = (doc as any).internal.getCurrentPageInfo().pageNumber
            addCuiFooter(currentPage, pageCount)
          },
        })

        // Update yPos after table
        const finalY = (doc as any).lastAutoTable.finalY
        yPos = finalY + 8
      }
    })

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-PMI-Schedule-Report-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  const handleExportToExcel = () => {
    if (!reportData) return

    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = ['ACSS PMI Schedule Report']
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = reportData.program ? [`Program: ${reportData.program.name}`] : []
    const reportInfoRow4 = [`Total PMIs: ${reportData.total}`]
    const reportInfoRow5 = [`Overdue: ${reportData.by_status.overdue} | Due Soon: ${reportData.by_status.due_soon} | Upcoming: ${reportData.by_status.upcoming} | Completed: ${reportData.by_status.completed}`]

    const allRows: any[] = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      ...(reportInfoRow3.length ? [reportInfoRow3] : []),
      reportInfoRow4,
      reportInfoRow5,
      blankRow
    ]

    // Add each status section
    const sections: Array<{ title: string; pmis: PMI[] }> = [
      { title: 'OVERDUE PMIs', pmis: reportData.grouped_by_status.overdue },
      { title: 'DUE SOON - Within 7 Days', pmis: reportData.grouped_by_status.due_soon },
      { title: 'UPCOMING PMIs', pmis: reportData.grouped_by_status.upcoming },
      { title: 'COMPLETED PMIs', pmis: reportData.grouped_by_status.completed }
    ]

    sections.forEach(section => {
      if (section.pmis.length > 0) {
        // Section header
        allRows.push([section.title])
        allRows.push([`Count: ${section.pmis.length}`])
        allRows.push(blankRow)

        // Table header
        allRows.push([
          'Asset S/N',
          'Asset Name',
          'PMI Type',
          'WUC Code',
          'Next Due Date',
          'Days Until Due',
          'Interval (Days)',
          'Completed Date',
          'Status'
        ])

        // PMI rows
        section.pmis.forEach(pmi => {
          allRows.push([
            pmi.asset_sn,
            pmi.asset_name || '',
            pmi.pmi_type,
            pmi.wuc_cd || '',
            formatDate(pmi.next_due_date),
            pmi.days_until_due.toString(),
            pmi.interval_days.toString(),
            pmi.completed_date ? formatDate(pmi.completed_date) : '',
            pmi.status.toUpperCase().replace('_', ' ')
          ])
        })

        allRows.push(blankRow)
      }
    })

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']
    allRows.push(cuiFooterRow)

    // Create worksheet from array of arrays
    const ws = XLSX.utils.aoa_to_sheet(allRows)

    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Asset S/N
      { wch: 30 },  // Asset Name
      { wch: 25 },  // PMI Type
      { wch: 12 },  // WUC Code
      { wch: 15 },  // Next Due Date
      { wch: 15 },  // Days Until Due
      { wch: 15 },  // Interval (Days)
      { wch: 15 },  // Completed Date
      { wch: 15 },  // Status
    ]

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'PMI Schedule')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-PMI-Schedule-Report-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading PMI schedule report...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <div className="flex">
          <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">Error</h3>
            <div className="mt-2 text-sm text-red-700">{error}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!reportData) {
    return null
  }

  return (
    <div>
      {/* Print-only CUI Header */}
      <div className="print-only print-cui-header" style={{ display: 'none' }}>
        CONTROLLED UNCLASSIFIED INFORMATION (CUI)
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">PMI Schedule Report</h1>
        {reportData.program && (
          <p className="mt-1 text-sm text-gray-600">
            Program: {reportData.program.name}
          </p>
        )}
        <p className="text-sm text-gray-500">
          Generated: {formatDate(reportData.generated_at)}
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <div className="bg-white overflow-hidden shadow rounded-lg border border-red-200">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <ExclamationTriangleIcon className="h-6 w-6 text-red-600" aria-hidden="true" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Overdue</dt>
                  <dd className="flex items-baseline">
                    <div className="text-2xl font-semibold text-red-600">
                      {reportData.by_status.overdue}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg border border-yellow-200">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <ClockIcon className="h-6 w-6 text-yellow-600" aria-hidden="true" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Due Soon</dt>
                  <dd className="flex items-baseline">
                    <div className="text-2xl font-semibold text-yellow-600">
                      {reportData.by_status.due_soon}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg border border-green-200">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <CalendarDaysIcon className="h-6 w-6 text-green-600" aria-hidden="true" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Upcoming</dt>
                  <dd className="flex items-baseline">
                    <div className="text-2xl font-semibold text-green-600">
                      {reportData.by_status.upcoming}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg border border-gray-200">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <CheckCircleIcon className="h-6 w-6 text-gray-600" aria-hidden="true" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Completed</dt>
                  <dd className="flex items-baseline">
                    <div className="text-2xl font-semibold text-gray-900">
                      {reportData.by_status.completed}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* PMI Sections by Status */}
      <div className="space-y-6">
        {/* Overdue Section */}
        {reportData.by_status.overdue > 0 && (
          <div className="bg-white shadow rounded-lg border border-red-200">
            <button
              onClick={() => toggleSection('overdue')}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 mr-3" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Overdue PMIs ({reportData.by_status.overdue})
                </h2>
              </div>
              <svg
                className={`h-5 w-5 text-gray-500 transition-transform ${
                  expandedSections.overdue ? 'rotate-180' : ''
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expandedSections.overdue && (
              <div className="border-t border-red-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-red-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Asset
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        PMI Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        WUC
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Due Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Days Overdue
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {reportData.grouped_by_status.overdue.map((pmi) => (
                      <tr key={pmi.pmi_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{pmi.asset_sn}</div>
                          <div className="text-sm text-gray-500">{pmi.asset_name}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {pmi.pmi_type}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {pmi.wuc_cd}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatDate(pmi.next_due_date)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {getDaysUntilDueBadge(pmi.days_until_due)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(pmi.status)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Due Soon Section */}
        {reportData.by_status.due_soon > 0 && (
          <div className="bg-white shadow rounded-lg border border-yellow-200">
            <button
              onClick={() => toggleSection('due_soon')}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <ClockIcon className="h-5 w-5 text-yellow-600 mr-3" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Due Soon (Within 7 Days) ({reportData.by_status.due_soon})
                </h2>
              </div>
              <svg
                className={`h-5 w-5 text-gray-500 transition-transform ${
                  expandedSections.due_soon ? 'rotate-180' : ''
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expandedSections.due_soon && (
              <div className="border-t border-yellow-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-yellow-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Asset
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        PMI Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        WUC
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Due Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Days Until Due
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {reportData.grouped_by_status.due_soon.map((pmi) => (
                      <tr key={pmi.pmi_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{pmi.asset_sn}</div>
                          <div className="text-sm text-gray-500">{pmi.asset_name}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {pmi.pmi_type}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {pmi.wuc_cd}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatDate(pmi.next_due_date)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {getDaysUntilDueBadge(pmi.days_until_due)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(pmi.status)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Upcoming Section */}
        {reportData.by_status.upcoming > 0 && (
          <div className="bg-white shadow rounded-lg border border-green-200">
            <button
              onClick={() => toggleSection('upcoming')}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <CalendarDaysIcon className="h-5 w-5 text-green-600 mr-3" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Upcoming PMIs ({reportData.by_status.upcoming})
                </h2>
              </div>
              <svg
                className={`h-5 w-5 text-gray-500 transition-transform ${
                  expandedSections.upcoming ? 'rotate-180' : ''
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expandedSections.upcoming && (
              <div className="border-t border-green-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-green-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Asset
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        PMI Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        WUC
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Due Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Days Until Due
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {reportData.grouped_by_status.upcoming.map((pmi) => (
                      <tr key={pmi.pmi_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{pmi.asset_sn}</div>
                          <div className="text-sm text-gray-500">{pmi.asset_name}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {pmi.pmi_type}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {pmi.wuc_cd}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatDate(pmi.next_due_date)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {getDaysUntilDueBadge(pmi.days_until_due)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(pmi.status)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Completed Section */}
        {reportData.by_status.completed > 0 && (
          <div className="bg-white shadow rounded-lg border border-gray-200">
            <button
              onClick={() => toggleSection('completed')}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <CheckCircleIcon className="h-5 w-5 text-gray-600 mr-3" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Completed PMIs ({reportData.by_status.completed})
                </h2>
              </div>
              <svg
                className={`h-5 w-5 text-gray-500 transition-transform ${
                  expandedSections.completed ? 'rotate-180' : ''
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expandedSections.completed && (
              <div className="border-t border-gray-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Asset
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        PMI Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        WUC
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Completed Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Next Due
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {reportData.grouped_by_status.completed.map((pmi) => (
                      <tr key={pmi.pmi_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{pmi.asset_sn}</div>
                          <div className="text-sm text-gray-500">{pmi.asset_name}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {pmi.pmi_type}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {pmi.wuc_cd}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {pmi.completed_date ? formatDate(pmi.completed_date) : '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatDate(pmi.next_due_date)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(pmi.status)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Export Buttons */}
      <div className="mt-6 flex justify-end space-x-2 no-print">
        <button
          type="button"
          onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          title="Print Report"
        >
          <PrinterIcon className="h-5 w-5" />
          Print
        </button>
        <button
          type="button"
          onClick={handleExportToPDF}
          className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
          title="Export to PDF"
        >
          <DocumentArrowDownIcon className="h-5 w-5" />
          Export PDF
        </button>
        <button
          type="button"
          onClick={handleExportToExcel}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
          title="Export to Excel"
        >
          <DocumentArrowDownIcon className="h-5 w-5" />
          Export Excel
        </button>
      </div>

      {/* Print-only CUI Footer */}
      <div className="print-only print-cui-footer print-footer" style={{ display: 'none' }}>
        CUI - CONTROLLED UNCLASSIFIED INFORMATION
      </div>
    </div>
  )
}
