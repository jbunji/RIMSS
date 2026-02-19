import { useState, useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'
import { ChevronDownIcon, ChevronUpIcon, DocumentArrowDownIcon, PrinterIcon } from '@heroicons/react/24/outline'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface AssetDetails {
  asset_id: number
  serno: string
  partno: string
  part_name: string
  status_cd: string
  status_name: string
  location: string
  loc_type: string
}

interface SystemTypeGroup {
  system_type: string
  total_count: number
  status_breakdown: Record<string, number>
  assets: AssetDetails[]
}

interface InventoryReportData {
  program: {
    pgm_id: number
    pgm_cd: string
    pgm_name: string
  }
  total_assets: number
  system_types: SystemTypeGroup[]
  generated_at: string
}

export default function InventoryReportPage() {
  const { token, user, currentProgramId } = useAuthStore()
  const [reportData, setReportData] = useState<InventoryReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedSystems, setExpandedSystems] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchInventoryReport()
  }, [currentProgramId])

  const fetchInventoryReport = async () => {
    setLoading(true)
    setError('')

    try {
      const params = new URLSearchParams()
      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      const url = `/api/reports/inventory${params.toString() ? '?' + params.toString() : ''}`

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch inventory report')
      }

      const data = await response.json()
      setReportData(data)

      // Expand all systems by default
      setExpandedSystems(new Set(data.system_types.map((st: SystemTypeGroup) => st.system_type)))
    } catch (err) {
      console.error('Error fetching inventory report:', err)
      setError('Failed to load inventory report. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const toggleSystemExpansion = (systemType: string) => {
    setExpandedSystems(prev => {
      const newSet = new Set(prev)
      if (newSet.has(systemType)) {
        newSet.delete(systemType)
      } else {
        newSet.add(systemType)
      }
      return newSet
    })
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
    doc.text('ACSS Inventory Report by System Type', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    doc.text(`Program: ${reportData.program.pgm_cd} - ${reportData.program.pgm_name}`, 14, 33)
    doc.text(`Total Assets: ${reportData.total_assets} | System Types: ${reportData.system_types.length}`, 14, 38)

    let yPos = 43

    // Add each system type section
    reportData.system_types.forEach((systemType, index) => {
      // Check if we need a new page
      if (yPos > pageHeight - 40) {
        doc.addPage()
        addCuiHeader()
        yPos = 18
      }

      // System type header
      doc.setFontSize(12)
      doc.setFont('helvetica', 'bold')
      doc.text(`System: ${systemType.system_type || 'Unknown'} (${systemType.total_count} assets)`, 14, yPos)
      yPos += 5

      // Status breakdown
      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      const statusBreakdown = Object.entries(systemType.status_breakdown)
        .map(([status, count]) => `${status}: ${count}`)
        .join(' | ')
      doc.text(`Status: ${statusBreakdown}`, 14, yPos)
      yPos += 5

      // Asset table
      const tableHeaders = ['Serial Number', 'Part Number', 'Part Name', 'Status', 'Location']
      const tableData = systemType.assets.map(asset => [
        asset.serno,
        asset.partno,
        asset.part_name ? asset.part_name.substring(0, 30) : '',
        asset.status_name,
        asset.location || '-'
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
          fillColor: [59, 130, 246],
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
    })

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Inventory-Report-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  const exportToExcel = () => {
    if (!reportData) return

    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = ['ACSS Inventory Report by System Type']
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Program: ${reportData.program.pgm_cd} - ${reportData.program.pgm_name}`]
    const reportInfoRow4 = [`Total Assets: ${reportData.total_assets}`]
    const reportInfoRow5 = [`System Types: ${reportData.system_types.length}`]

    const allRows: any[] = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      reportInfoRow3,
      reportInfoRow4,
      reportInfoRow5,
      blankRow
    ]

    // Add each system type section
    reportData.system_types.forEach((systemType) => {
      // System type header
      allRows.push([`System Type: ${systemType.system_type || 'Unknown'}`])
      allRows.push([`Total Assets: ${systemType.total_count}`])

      // Status breakdown
      const statusBreakdown = Object.entries(systemType.status_breakdown)
        .map(([status, count]) => `${status}: ${count}`)
        .join(' | ')
      allRows.push([`Status Breakdown: ${statusBreakdown}`])
      allRows.push(blankRow)

      // Asset table header
      allRows.push([
        'Serial Number',
        'Part Number',
        'Part Name',
        'Status',
        'Location',
        'Location Type'
      ])

      // Asset rows
      systemType.assets.forEach(asset => {
        allRows.push([
          asset.serno,
          asset.partno,
          asset.part_name || '',
          asset.status_name,
          asset.location || '',
          asset.loc_type || ''
        ])
      })

      allRows.push(blankRow)
      allRows.push(blankRow)
    })

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']
    allRows.push(cuiFooterRow)

    // Create worksheet from array of arrays
    const ws = XLSX.utils.aoa_to_sheet(allRows)

    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Serial Number / System Type
      { wch: 20 },  // Part Number
      { wch: 30 },  // Part Name
      { wch: 15 },  // Status
      { wch: 20 },  // Location
      { wch: 15 },  // Location Type
    ]

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Inventory Report')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Inventory-Report-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <div className="text-sm text-red-700">{error}</div>
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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Inventory Report by System Type</h1>
            <p className="mt-2 text-sm text-gray-600">
              Program: {reportData.program.pgm_name} ({reportData.program.pgm_cd})
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

      {/* Summary */}
      <div className="bg-white shadow rounded-lg mb-6 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Summary</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="text-sm font-medium text-blue-600">Total Assets</div>
            <div className="mt-1 text-3xl font-bold text-blue-900">{reportData.total_assets}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-sm font-medium text-green-600">System Types</div>
            <div className="mt-1 text-3xl font-bold text-green-900">{reportData.system_types.length}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <div className="text-sm font-medium text-purple-600">Generated</div>
            <div className="mt-1 text-sm font-semibold text-purple-900">
              {new Date(reportData.generated_at).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')}
            </div>
          </div>
        </div>
      </div>

      {/* System Type Groups */}
      <div className="space-y-4">
        {reportData.system_types.map(systemType => {
          const isExpanded = expandedSystems.has(systemType.system_type)

          return (
            <div key={systemType.system_type} className="bg-white shadow rounded-lg overflow-hidden">
              {/* System Type Header */}
              <button
                onClick={() => toggleSystemExpansion(systemType.system_type)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center space-x-4">
                  <div className="flex-shrink-0">
                    {isExpanded ? (
                      <ChevronUpIcon className="h-5 w-5 text-gray-400" />
                    ) : (
                      <ChevronDownIcon className="h-5 w-5 text-gray-400" />
                    )}
                  </div>
                  <div className="text-left">
                    <h3 className="text-lg font-semibold text-gray-900">{systemType.system_type}</h3>
                    <p className="text-sm text-gray-600">
                      {systemType.total_count} {systemType.total_count === 1 ? 'asset' : 'assets'}
                    </p>
                  </div>
                </div>

                {/* Status Breakdown Badges */}
                <div className="flex flex-wrap gap-2">
                  {Object.entries(systemType.status_breakdown).map(([status, count]) => (
                    <span
                      key={status}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800"
                    >
                      {status}: {count}
                    </span>
                  ))}
                </div>
              </button>

              {/* Expanded Asset List */}
              {isExpanded && (
                <div className="border-t border-gray-200">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Serial Number
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Part Number
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Part Name
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Location
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Location Type
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {systemType.assets.map(asset => (
                          <tr key={asset.asset_id} className="hover:bg-gray-50 cursor-pointer transition-colors">
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {asset.serno}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {asset.partno}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {asset.part_name}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  asset.status_cd === 'FMC'
                                    ? 'bg-green-100 text-green-800'
                                    : asset.status_cd === 'PMC'
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : asset.status_cd === 'NMCM' || asset.status_cd === 'NMCS'
                                    ? 'bg-red-100 text-red-800'
                                    : 'bg-gray-100 text-gray-800'
                                }`}
                              >
                                {asset.status_name}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {asset.location}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  asset.loc_type === 'depot'
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-purple-100 text-purple-800'
                                }`}
                              >
                                {asset.loc_type === 'depot' ? 'Depot' : 'Field'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Empty State */}
      {reportData.system_types.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No inventory data available for this program.</p>
        </div>
      )}

      {/* Print-only CUI Footer */}
      <div className="print-only print-cui-footer print-footer" style={{ display: 'none' }}>
        CUI - CONTROLLED UNCLASSIFIED INFORMATION
      </div>
    </div>
  )
}
