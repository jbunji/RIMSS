import { useState, useEffect, useCallback, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Dialog, Transition } from '@headlessui/react'
import {
  CubeIcon,
  MagnifyingGlassIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronUpDownIcon,
  PencilIcon,
  XMarkIcon,
  CheckIcon,
  PlusIcon,
  TrashIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  DocumentArrowDownIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline'
import { useAuthStore } from '../stores/authStore'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatLocationHierarchical, compareLocations } from '../utils/locationFormatter'
import type { Location as LocationType } from '../utils/locationFormatter'

// Reference data interfaces
type Location = LocationType

interface AssetStatus {
  status_cd: string
  status_name: string
  description: string
}

// Spare interface matching backend
interface Spare {
  asset_id: number
  serno: string
  partno: string
  part_name: string
  pgm_id: number
  status_cd: string
  status_name: string
  active: boolean
  location: string
  loc_type: 'depot' | 'field'
  admin_loc: string
  cust_loc: string
  notes: string | null
  in_transit: boolean
  bad_actor: boolean
  uii: string | null
  mfg_date: string | null
  remarks: string | null
}

// Zod schema for editing spare
const editSpareSchema = z.object({
  status_cd: z.string().trim().min(1, 'Status is required'),
  admin_loc: z.string().trim().min(1, 'Assigned base is required'),
  cust_loc: z.string().trim().min(1, 'Current base is required'),
  notes: z.string().trim().max(500, 'Notes must be at most 500 characters').optional().or(z.literal('')),
})

type EditSpareFormData = z.infer<typeof editSpareSchema>

// Zod schema for creating spare
const createSpareSchema = z.object({
  partno: z.string().trim().min(1, 'Part number is required').max(50, 'Part number must be at most 50 characters'),
  serno: z.string().trim().min(1, 'Serial number is required').max(50, 'Serial number must be at most 50 characters'),
  status: z.string().trim().optional().or(z.literal('')),
  loc_id: z.string().trim().optional().or(z.literal('')),
  warranty_exp: z.string().trim().optional().or(z.literal('')),
  mfg_date: z.string().trim().optional().or(z.literal('')),
  unit_price: z.string().trim().optional().or(z.literal('')),
  remarks: z.string().trim().max(500, 'Remarks must be at most 500 characters').optional().or(z.literal('')),
})

type CreateSpareFormData = z.infer<typeof createSpareSchema>

interface Pagination {
  page: number
  limit: number
  total: number
  total_pages: number
}

interface ProgramInfo {
  pgm_id: number
  pgm_cd: string
  pgm_name: string
}

interface SparesResponse {
  spares: Spare[]
  pagination: Pagination
  program: ProgramInfo
}

// Status badge colors (aligned with AFI 21-103)
const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  FMC: { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200' },
  PMC: { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200' },
  PMCM: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-300' },
  PMCS: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-300' },
  PMCB: { bg: 'bg-yellow-100', text: 'text-yellow-900', border: 'border-yellow-400' },
  NMCM: { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200' },
  NMCS: { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200' },
  NMCB: { bg: 'bg-red-200', text: 'text-red-900', border: 'border-red-300' },
}

export default function SparesPage() {
  const navigate = useNavigate()
  const { token, currentProgramId, user } = useAuthStore()

  // Check if user can edit spares
  const canEditSpare = user && ['ADMIN', 'DEPOT_MANAGER'].includes(user.role)

  // State
  const [spares, setSpares] = useState<Spare[]>([])
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0, total_pages: 1 })
  const [program, setProgram] = useState<ProgramInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Modal state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isMassUpdateModalOpen, setIsMassUpdateModalOpen] = useState(false)
  const [isBulkDeleteConfirm1Open, setIsBulkDeleteConfirm1Open] = useState(false)
  const [isBulkDeleteConfirm2Open, setIsBulkDeleteConfirm2Open] = useState(false)
  const [selectedSpare, setSelectedSpare] = useState<Spare | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const [createModalError, setCreateModalError] = useState<string | null>(null)
  const [massUpdateError, setMassUpdateError] = useState<string | null>(null)
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isMassUpdating, setIsMassUpdating] = useState(false)
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)

  // Mass update state
  const [selectedSpareIds, setSelectedSpareIds] = useState<number[]>([])
  const [massUpdateField, setMassUpdateField] = useState<string>('status_cd')
  const [massUpdateValue, setMassUpdateValue] = useState<string>('')

  // Reference data for form
  const [adminLocations, setAdminLocations] = useState<Location[]>([])
  const [custodialLocations, setCustodialLocations] = useState<Location[]>([])
  const [assetStatuses, setAssetStatuses] = useState<AssetStatus[]>([])

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [showDeleted, setShowDeleted] = useState(false)

  // Sorting
  type SortColumn = 'serno' | 'partno' | 'part_name' | 'status_cd' | 'location'
  type SortOrder = 'asc' | 'desc'
  const [sortBy, setSortBy] = useState<SortColumn>('partno')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  // Form setup for editing
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditSpareFormData>({
    resolver: zodResolver(editSpareSchema),
  })

  // Form setup for creating
  const {
    register: registerCreate,
    handleSubmit: handleSubmitCreate,
    reset: resetCreate,
    formState: { errors: createErrors, isSubmitting: isCreating },
  } = useForm<CreateSpareFormData>({
    resolver: zodResolver(createSpareSchema),
  })

  // Fetch reference data
  useEffect(() => {
    const fetchReferenceData = async () => {
      if (!token) return

      try {
        // Fetch locations (admin and custodial)
        const locRes = await fetch('/api/reference/locations', {
          headers: { 'Authorization': `Bearer ${token}` },
        })
        if (locRes.ok) {
          const data = await locRes.json()
          setAdminLocations(data.admin_locations || [])
          setCustodialLocations(data.custodial_locations || [])
        }

        // Fetch asset statuses
        const statusRes = await fetch('/api/reference/asset-statuses', {
          headers: { 'Authorization': `Bearer ${token}` },
        })
        if (statusRes.ok) {
          const data = await statusRes.json()
          setAssetStatuses(data.statuses || [])
        }
      } catch (err) {
        console.error('Failed to fetch reference data:', err)
      }
    }

    fetchReferenceData()
  }, [token])

  // Fetch spares from backend
  const fetchSpares = useCallback(async () => {
    if (!token || !currentProgramId) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const queryParams = new URLSearchParams({
        program_id: currentProgramId.toString(),
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
        sort_by: sortBy,
        sort_order: sortOrder,
      })

      if (searchQuery) {
        queryParams.append('search', searchQuery)
      }

      if (statusFilter) {
        queryParams.append('status', statusFilter)
      }

      if (locationFilter) {
        queryParams.append('location', locationFilter)
      }

      if (showDeleted) {
        queryParams.append('show_deleted', 'true')
      }

      const response = await fetch(`/api/spares?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        credentials: 'include',
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to fetch spares')
      }

      const data: SparesResponse = await response.json()
      setSpares(data.spares)
      setPagination(data.pagination)
      setProgram(data.program)
    } catch (err) {
      console.error('Error fetching spares:', err)
      setError(err instanceof Error ? err.message : 'Failed to load spares')
    } finally {
      setLoading(false)
    }
  }, [token, currentProgramId, pagination.page, pagination.limit, sortBy, sortOrder, searchQuery, statusFilter, locationFilter, showDeleted])

  useEffect(() => {
    fetchSpares()
  }, [fetchSpares])

  // Handle sort column click
  const handleSort = (column: SortColumn) => {
    if (sortBy === column) {
      // Toggle order if same column
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      // Set new column with ascending order
      setSortBy(column)
      setSortOrder('asc')
    }
    // Reset to page 1 when sorting changes
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Get sort icon for column header
  const getSortIcon = (column: SortColumn) => {
    if (sortBy !== column) {
      return <ChevronUpDownIcon className="h-4 w-4 text-gray-400" />
    }
    return sortOrder === 'asc'
      ? <ChevronUpIcon className="h-4 w-4 text-primary-600" />
      : <ChevronDownIcon className="h-4 w-4 text-primary-600" />
  }

  // Handle pagination
  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }))
  }

  // Handle search
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Handle status filter
  const handleStatusFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Handle location filter
  const handleLocationFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocationFilter(e.target.value)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  // Clear all filters
  const handleClearFilters = () => {
    setSearchQuery('')
    setStatusFilter('')
    setLocationFilter('')
    setPagination(prev => ({ ...prev, page: 1 }))
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

  // Export spares to PDF with CUI markings
  const exportToPDF = async () => {
    try {
      // Fetch ALL spares with current filters (no pagination)
      const queryParams = new URLSearchParams({
        program_id: currentProgramId!.toString(),
        page: '1',
        limit: '10000', // Large limit to get all records
        sort_by: sortBy,
        sort_order: sortOrder,
      })

      if (searchQuery) {
        queryParams.append('search', searchQuery)
      }

      if (statusFilter) {
        queryParams.append('status', statusFilter)
      }

      if (locationFilter) {
        queryParams.append('location', locationFilter)
      }

      if (showDeleted) {
        queryParams.append('show_deleted', 'true')
      }

      const response = await fetch(`/api/spares?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error('Failed to fetch spares for export')
      }

      const data: SparesResponse = await response.json()
      const allSpares = data.spares

      // Now generate PDF with all filtered spares
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
    doc.text('ACSS Spares Inventory Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    doc.text(`Total Spares: ${allSpares.length}`, 14, 33)
    if (program) {
      doc.text(`Program: ${program.pgm_cd} - ${program.pgm_name}`, 14, 38)
    }

    // Filters info
    let yPos = program ? 43 : 38
    const hasActiveFilters = searchQuery || statusFilter || locationFilter || showDeleted
    if (hasActiveFilters) {
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      const filters: string[] = []
      if (searchQuery) filters.push(`Search: "${searchQuery}"`)
      if (statusFilter) filters.push(`Status: ${statusFilter}`)
      if (locationFilter) filters.push(`Location: "${locationFilter}"`)
      if (showDeleted) filters.push('Including deleted records')
      doc.text(`Filters: ${filters.join(', ')}`, 14, yPos)
      yPos += 5
    }

    // Prepare table data
    const tableHeaders = [
      'Serial Number',
      'Part Number',
      'Part Name',
      'Status',
      'Location',
      'UII',
      'Remarks'
    ]

    const tableData = allSpares.map(spare => [
      spare.serno,
      spare.partno,
      spare.part_name,
      spare.status_cd,
      spare.location || '-',
      spare.uii || '-',
      spare.remarks ? spare.remarks.substring(0, 50) : '-'
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
      const filename = `CUI-Spares-${zuluDate}.pdf`

      // Save the PDF
      doc.save(filename)
    } catch (err) {
      console.error('Error exporting to PDF:', err)
      alert('Failed to export PDF. Please try again.')
    }
  }

  // Export spares to Excel with CUI markings
  const exportToExcel = async () => {
    try {
      // Fetch ALL spares with current filters (no pagination)
      const queryParams = new URLSearchParams({
        program_id: currentProgramId!.toString(),
        page: '1',
        limit: '10000', // Large limit to get all records
        sort_by: sortBy,
        sort_order: sortOrder,
      })

      if (searchQuery) {
        queryParams.append('search', searchQuery)
      }

      if (statusFilter) {
        queryParams.append('status', statusFilter)
      }

      if (locationFilter) {
        queryParams.append('location', locationFilter)
      }

      if (showDeleted) {
        queryParams.append('show_deleted', 'true')
      }

      const response = await fetch(`/api/spares?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error('Failed to fetch spares for export')
      }

      const data: SparesResponse = await response.json()
      const allSpares = data.spares

      // Now generate Excel with all filtered spares
      const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

      // Prepare data rows with CUI header
      const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
      const blankRow: string[] = []
      const reportInfoRow1 = ['ACSS Spares Inventory Report']
      const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
      const reportInfoRow3 = [`Total Spares: ${allSpares.length}`]
    const reportInfoRow4 = program ? [`Program: ${program.pgm_cd} - ${program.pgm_name}`] : []

    // Filter info
    const filters: string[] = []
    if (searchQuery) filters.push(`Search: "${searchQuery}"`)
    if (statusFilter) filters.push(`Status: ${statusFilter}`)
    if (locationFilter) filters.push(`Location: "${locationFilter}"`)
    if (showDeleted) filters.push('Including deleted records')
    const filterRow = filters.length > 0 ? [`Filters: ${filters.join(', ')}`] : []

    // Table header row
    const headerRow = [
      'Serial Number',
      'Part Number',
      'Part Name',
      'Status',
      'Location',
      'Location Type',
      'Assigned Base',
      'Current Base',
      'UII',
      'Manufacture Date',
      'In Transit',
      'Bad Actor',
      'Active',
      'Remarks'
    ]

    // Data rows
    const dataRows = allSpares.map(spare => [
      spare.serno,
      spare.partno,
      spare.part_name,
      spare.status_cd,
      spare.location || '',
      spare.loc_type || '',
      spare.admin_loc || '',
      spare.cust_loc || '',
      spare.uii || '',
      spare.mfg_date ? new Date(spare.mfg_date).toISOString().split('T')[0] : '',
      spare.in_transit ? 'Yes' : 'No',
      spare.bad_actor ? 'Yes' : 'No',
      spare.active ? 'Yes' : 'No',
      spare.remarks || ''
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
      { wch: 18 },  // Serial Number
      { wch: 18 },  // Part Number
      { wch: 30 },  // Part Name
      { wch: 12 },  // Status
      { wch: 25 },  // Location
      { wch: 15 },  // Location Type
      { wch: 20 },  // Assigned Base
      { wch: 20 },  // Current Base
      { wch: 18 },  // UII
      { wch: 15 },  // Manufacture Date
      { wch: 12 },  // In Transit
      { wch: 12 },  // Bad Actor
      { wch: 10 },  // Active
      { wch: 40 },  // Remarks
    ]

    // Merge CUI header cells across all columns
    const numCols = headerRow.length
    const headerRowIdx = reportInfoRow4.length ? 8 : 7
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
      { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
      { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
      { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Total spares
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

    // Style CUI header and footer with yellow background
    // Note: XLSX doesn't support cell styling in basic mode, but we can add the cell references

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Spares Inventory')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Spares-${zuluDate}.xlsx`

      // Write file
      XLSX.writeFile(wb, filename)
    } catch (err) {
      console.error('Error exporting to Excel:', err)
      alert('Failed to export Excel. Please try again.')
    }
  }

  // Handle create spare button click
  const handleCreateClick = () => {
    setCreateModalError(null)
    resetCreate({
      partno: '',
      serno: '',
      status: 'AVAILABLE',
      loc_id: '',
      warranty_exp: '',
      mfg_date: '',
      unit_price: '',
      remarks: '',
    })
    setIsCreateModalOpen(true)
  }

  // Handle create spare form submission
  const onCreateSubmit = async (data: CreateSpareFormData) => {
    if (!token) return

    setCreateModalError(null)

    try {
      const response = await fetch('/api/spares', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create spare')
      }

      // Success - close modal and refresh list
      setIsCreateModalOpen(false)
      setSuccessMessage('Spare created successfully!')
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setCreateModalError(err instanceof Error ? err.message : 'Failed to create spare')
    }
  }

  // Handle edit spare
  const handleEditClick = (e: React.MouseEvent, spare: Spare) => {
    e.stopPropagation() // Prevent row click navigation
    setSelectedSpare(spare)
    setModalError(null)
    reset({
      status_cd: spare.status_cd,
      admin_loc: spare.admin_loc,
      cust_loc: spare.cust_loc,
      notes: spare.notes || '',
    })
    setIsEditModalOpen(true)
  }

  // Handle form submission
  const onSubmit = async (data: EditSpareFormData) => {
    if (!selectedSpare || !token) return

    setModalError(null)

    try {
      const response = await fetch(`/api/assets/${selectedSpare.asset_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to update spare')
      }

      // Success - close modal and refresh list
      setIsEditModalOpen(false)
      setSuccessMessage('Spare updated successfully!')
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to update spare')
    }
  }

  // Handle delete spare click
  const handleDeleteClick = (e: React.MouseEvent, spare: Spare) => {
    e.stopPropagation() // Prevent row click navigation
    setSelectedSpare(spare)
    setModalError(null)
    setIsDeleteModalOpen(true)
  }

  // Handle delete confirmation
  const handleDeleteConfirm = async () => {
    if (!selectedSpare || !token) return

    setModalError(null)
    setIsDeleting(true)

    try {
      const response = await fetch(`/api/assets/${selectedSpare.asset_id}/permanent`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete spare')
      }

      // Success - close modal and refresh list
      setIsDeleteModalOpen(false)
      setSuccessMessage('Spare deleted successfully!')
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to delete spare')
    } finally {
      setIsDeleting(false)
    }
  }

  // Handle reactivate spare
  const handleReactivateClick = async (e: React.MouseEvent, spare: Spare) => {
    e.stopPropagation() // Prevent row click navigation

    if (!token) return

    try {
      const response = await fetch(`/api/assets/${spare.asset_id}/reactivate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to reactivate spare')
      }

      // Success - show message and refresh list
      setSuccessMessage(`Spare "${spare.serno}" reactivated successfully!`)
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reactivate spare')
      setTimeout(() => setError(null), 3000)
    }
  }

  // Handle checkbox selection
  const handleCheckboxChange = (assetId: number) => {
    setSelectedSpareIds((prev) => {
      if (prev.includes(assetId)) {
        return prev.filter((id) => id !== assetId)
      } else {
        return [...prev, assetId]
      }
    })
  }

  // Handle select all checkbox
  const handleSelectAll = () => {
    if (selectedSpareIds.length === spares.length) {
      // Unselect all
      setSelectedSpareIds([])
    } else {
      // Select all
      setSelectedSpareIds(spares.map((spare) => spare.asset_id))
    }
  }

  // Open mass update modal
  const handleMassUpdateClick = () => {
    setMassUpdateError(null)
    setMassUpdateField('status_cd')
    setMassUpdateValue('')
    setIsMassUpdateModalOpen(true)
  }

  // Handle mass update submission
  const handleMassUpdateSubmit = async () => {
    if (!token || selectedSpareIds.length === 0 || !massUpdateValue) return

    setMassUpdateError(null)
    setIsMassUpdating(true)

    try {
      const response = await fetch('/api/assets/mass-update', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          asset_ids: selectedSpareIds,
          field: massUpdateField,
          value: massUpdateValue,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to update spares')
      }

      const result = await response.json()

      // Success - close modal and refresh list
      setIsMassUpdateModalOpen(false)
      setSelectedSpareIds([])
      setSuccessMessage(`Successfully updated ${result.updated_count} spare(s)!`)
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setMassUpdateError(err instanceof Error ? err.message : 'Failed to update spares')
    } finally {
      setIsMassUpdating(false)
    }
  }

  // Handle bulk delete - first confirmation
  const handleBulkDeleteClick = () => {
    setBulkDeleteError(null)
    setIsBulkDeleteConfirm1Open(true)
  }

  // Handle first confirmation - proceed to second
  const handleBulkDeleteConfirm1 = () => {
    setIsBulkDeleteConfirm1Open(false)
    setIsBulkDeleteConfirm2Open(true)
  }

  // Handle second confirmation - actually delete
  const handleBulkDeleteConfirm2 = async () => {
    if (!token || selectedSpareIds.length === 0) return

    setBulkDeleteError(null)
    setIsBulkDeleting(true)

    try {
      const response = await fetch('/api/assets/bulk-delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          asset_ids: selectedSpareIds,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete spares')
      }

      const result = await response.json()

      // Success - close modal and refresh list
      setIsBulkDeleteConfirm2Open(false)
      setSelectedSpareIds([])
      setSuccessMessage(`Successfully deleted ${result.deleted_count} spare(s)!`)
      setTimeout(() => setSuccessMessage(null), 3000)
      fetchSpares()
    } catch (err) {
      setBulkDeleteError(err instanceof Error ? err.message : 'Failed to delete spares')
    } finally {
      setIsBulkDeleting(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <CubeIcon className="h-8 w-8 text-primary-600" />
          <h1 className="text-2xl font-bold text-gray-900">Spares Inventory</h1>
        </div>
        {program && (
          <p className="text-sm text-gray-600">
            Program: <span className="font-semibold">{program.pgm_name} ({program.pgm_cd})</span>
          </p>
        )}
      </div>

      {/* Success message */}
      {successMessage && (
        <div className="mb-4 rounded-md bg-green-50 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <CheckIcon className="h-5 w-5 text-green-400" />
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-green-800">{successMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Filters and Actions */}
      <div className="mb-4 bg-white p-4 rounded-lg shadow border border-gray-200">
        <div className="flex items-end justify-between gap-4 mb-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Search & Filter</h2>
            {user?.role === 'ADMIN' && (
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => {
                    setShowDeleted(e.target.checked)
                    setPagination(prev => ({ ...prev, page: 1 }))
                  }}
                  className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                />
                <span>Show deleted/inactive spares</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Export Buttons */}
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
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
              title="Export to Excel"
            >
              <DocumentArrowDownIcon className="h-5 w-5" />
              Export Excel
            </button>

            {/* Add/Edit Buttons (only for depot managers and admins) */}
            {canEditSpare && !showDeleted && (
              <>
                {selectedSpareIds.length > 0 && (
                  <>
                    <button
                      onClick={handleMassUpdateClick}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                    >
                      <PencilIcon className="h-5 w-5" />
                      Mass Update ({selectedSpareIds.length})
                    </button>
                    <button
                      onClick={handleBulkDeleteClick}
                      className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                    >
                      <TrashIcon className="h-5 w-5" />
                      Bulk Delete ({selectedSpareIds.length})
                    </button>
                  </>
                )}
                <button
                  onClick={handleCreateClick}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
                >
                  <PlusIcon className="h-5 w-5" />
                  Add Spare
                </button>
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Search */}
          <div className="md:col-span-3">
            <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-1">
              Search
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                id="search"
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder="Search by serial, part number, or name..."
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label htmlFor="status-filter" className="block text-sm font-medium text-gray-700 mb-1">
              Status
            </label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={handleStatusFilterChange}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md leading-5 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
            >
              <option value="">All Statuses</option>
              <option value="FMC">FMC - Fully Mission Capable</option>
              <option value="PMC">PMC - Partially Mission Capable</option>
              <option value="PMCM">PMCM - Partially Mission Capable (Maintenance)</option>
              <option value="PMCS">PMCS - Partially Mission Capable (Supply)</option>
              <option value="PMCB">PMCB - Partially Mission Capable (Both)</option>
              <option value="NMCM">NMCM - Not Mission Capable (Maintenance)</option>
              <option value="NMCS">NMCS - Not Mission Capable (Supply)</option>
              <option value="NMCB">NMCB - Not Mission Capable (Both)</option>
            </select>
          </div>

          {/* Location Filter */}
          <div>
            <label htmlFor="location-filter" className="block text-sm font-medium text-gray-700 mb-1">
              Location
            </label>
            <select
              id="location-filter"
              value={locationFilter}
              onChange={handleLocationFilterChange}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md leading-5 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
            >
              <option value="">All Locations</option>
              <option value="Depot Alpha">Depot Alpha</option>
              <option value="Depot Bravo">Depot Bravo</option>
              <option value="In Transit">In Transit</option>
            </select>
          </div>

          {/* Clear Filters Button */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              &nbsp;
            </label>
            <button
              onClick={handleClearFilters}
              disabled={!searchQuery && !statusFilter && !locationFilter}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md">
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <p className="mt-2 text-sm text-gray-500">Loading spares...</p>
        </div>
      )}

      {/* Spares Table */}
      {!loading && !error && (
        <div className="bg-white shadow rounded-lg border border-gray-200 overflow-hidden">
          {/* Table Header with Count */}
          <div className="px-6 py-3 border-b border-gray-200 bg-gray-50">
            <p className="text-sm text-gray-700">
              Showing <span className="font-semibold">{spares.length}</span> of{' '}
              <span className="font-semibold">{pagination.total}</span> spare parts
            </p>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {canEditSpare && !showDeleted && (
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSpareIds.length === spares.length && spares.length > 0}
                        onChange={handleSelectAll}
                        className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                      />
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('serno')}
                  >
                    <div className="flex items-center gap-1">
                      Serial Number
                      {getSortIcon('serno')}
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('partno')}
                  >
                    <div className="flex items-center gap-1">
                      Part Number
                      {getSortIcon('partno')}
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('part_name')}
                  >
                    <div className="flex items-center gap-1">
                      Part Name
                      {getSortIcon('part_name')}
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('status_cd')}
                  >
                    <div className="flex items-center gap-1">
                      Status
                      {getSortIcon('status_cd')}
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('location')}
                  >
                    <div className="flex items-center gap-1">
                      Location
                      {getSortIcon('location')}
                    </div>
                  </th>
                  {canEditSpare && (
                    <th
                      scope="col"
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                    >
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {spares.length === 0 ? (
                  <tr>
                    <td colSpan={canEditSpare && !showDeleted ? 7 : canEditSpare ? 6 : 5} className="px-6 py-12 text-center text-gray-500">
                      <CubeIcon className="mx-auto h-12 w-12 text-gray-400 mb-2" />
                      <p>No spare parts found</p>
                      {(searchQuery || statusFilter) && (
                        <p className="text-sm mt-1">Try adjusting your filters</p>
                      )}
                    </td>
                  </tr>
                ) : (
                  spares.map((spare) => (
                    <tr key={spare.asset_id} className="hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => navigate(`/assets/${spare.asset_id}`)}>
                      {canEditSpare && !showDeleted && (
                        <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSpareIds.includes(spare.asset_id)}
                            onChange={() => handleCheckboxChange(spare.asset_id)}
                            className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                          />
                        </td>
                      )}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="text-sm font-medium text-gray-900">{spare.serno}</div>
                          {spare.bad_actor && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                              BA
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{spare.partno}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{spare.part_name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                            statusColors[spare.status_cd]?.bg || 'bg-gray-100'
                          } ${
                            statusColors[spare.status_cd]?.text || 'text-gray-800'
                          } ${
                            statusColors[spare.status_cd]?.border || 'border-gray-200'
                          }`}
                        >
                          {spare.status_cd}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{spare.location}</div>
                      </td>
                      {canEditSpare && (
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {showDeleted ? (
                            <button
                              type="button"
                              onClick={(e) => handleReactivateClick(e, spare)}
                              className="text-green-600 hover:text-green-900 inline-flex items-center gap-1"
                            >
                              <ArrowPathIcon className="h-4 w-4" />
                              Reactivate
                            </button>
                          ) : (
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={(e) => handleEditClick(e, spare)}
                                className="text-primary-600 hover:text-primary-900 inline-flex items-center gap-1"
                              >
                                <PencilIcon className="h-4 w-4" />
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteClick(e, spare)}
                                className="text-red-600 hover:text-red-900 inline-flex items-center gap-1"
                              >
                                <TrashIcon className="h-4 w-4" />
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.total_pages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Page <span className="font-medium">{pagination.page}</span> of{' '}
                    <span className="font-medium">{pagination.total_pages}</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePageChange(pagination.page - 1)}
                    disabled={pagination.page === 1}
                    className="px-3 py-1 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => handlePageChange(pagination.page + 1)}
                    disabled={pagination.page === pagination.total_pages}
                    className="px-3 py-1 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Spare Modal */}
      <Transition.Root show={isCreateModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsCreateModalOpen}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div className="absolute right-0 top-0 pr-4 pt-4">
                    <button
                      type="button"
                      className="rounded-md bg-white text-gray-400 hover:text-gray-500"
                      onClick={() => setIsCreateModalOpen(false)}
                    >
                      <span className="sr-only">Close</span>
                      <XMarkIcon className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="sm:flex sm:items-start">
                    <div className="mt-3 text-center sm:mt-0 sm:text-left w-full">
                      <Dialog.Title as="h3" className="text-lg font-semibold leading-6 text-gray-900">
                        Create New Spare Part
                      </Dialog.Title>
                      <p className="mt-2 text-sm text-gray-500">
                        Add a new spare part to the inventory
                      </p>

                      {createModalError && (
                        <div className="mt-4 rounded-md bg-red-50 p-4">
                          <p className="text-sm text-red-800">{createModalError}</p>
                        </div>
                      )}

                      <form onSubmit={handleSubmitCreate(onCreateSubmit)} className="mt-6 space-y-4">
                        {/* Part Number */}
                        <div>
                          <label htmlFor="partno" className="block text-sm font-medium text-gray-700">
                            Part Number *
                          </label>
                          <input
                            type="text"
                            id="partno"
                            {...registerCreate('partno')}
                            placeholder="e.g., PN001"
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                          {createErrors.partno && (
                            <p className="mt-1 text-sm text-red-600">{createErrors.partno.message}</p>
                          )}
                        </div>

                        {/* Serial Number */}
                        <div>
                          <label htmlFor="serno" className="block text-sm font-medium text-gray-700">
                            Serial Number *
                          </label>
                          <input
                            type="text"
                            id="serno"
                            {...registerCreate('serno')}
                            placeholder="e.g., SN123"
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                          {createErrors.serno && (
                            <p className="mt-1 text-sm text-red-600">{createErrors.serno.message}</p>
                          )}
                        </div>

                        {/* Status */}
                        <div>
                          <label htmlFor="status" className="block text-sm font-medium text-gray-700">
                            Status
                          </label>
                          <select
                            id="status"
                            {...registerCreate('status')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          >
                            <option value="AVAILABLE">Available</option>
                            <option value="IN_USE">In Use</option>
                            <option value="MAINTENANCE">Maintenance</option>
                            <option value="RETIRED">Retired</option>
                          </select>
                        </div>

                        {/* Location */}
                        <div>
                          <label htmlFor="loc_id" className="block text-sm font-medium text-gray-700">
                            Location
                          </label>
                          <select
                            id="loc_id"
                            {...registerCreate('loc_id')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          >
                            <option value="">Select location (optional)</option>
                            {adminLocations.sort(compareLocations).map((loc) => (
                              <option key={loc.loc_id} value={loc.loc_id.toString()}>
                                {formatLocationHierarchical(loc)}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Warranty Expiration */}
                        <div>
                          <label htmlFor="warranty_exp" className="block text-sm font-medium text-gray-700">
                            Warranty Expiration
                          </label>
                          <input
                            type="date"
                            id="warranty_exp"
                            {...registerCreate('warranty_exp')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                        </div>

                        {/* Manufacturing Date */}
                        <div>
                          <label htmlFor="mfg_date" className="block text-sm font-medium text-gray-700">
                            Manufacturing Date
                          </label>
                          <input
                            type="date"
                            id="mfg_date"
                            {...registerCreate('mfg_date')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                        </div>

                        {/* Unit Price */}
                        <div>
                          <label htmlFor="unit_price" className="block text-sm font-medium text-gray-700">
                            Unit Price
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            id="unit_price"
                            {...registerCreate('unit_price')}
                            placeholder="0.00"
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                        </div>

                        {/* Remarks */}
                        <div>
                          <label htmlFor="remarks" className="block text-sm font-medium text-gray-700">
                            Remarks
                          </label>
                          <textarea
                            id="remarks"
                            {...registerCreate('remarks')}
                            rows={3}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                            placeholder="Additional notes..."
                          />
                          {createErrors.remarks && (
                            <p className="mt-1 text-sm text-red-600">{createErrors.remarks.message}</p>
                          )}
                        </div>

                        <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse gap-3">
                          <button
                            type="submit"
                            disabled={isCreating}
                            className="inline-flex w-full justify-center rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto"
                          >
                            {isCreating ? 'Creating...' : 'Create Spare'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsCreateModalOpen(false)}
                            disabled={isCreating}
                            className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Edit Spare Modal */}
      <Transition.Root show={isEditModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsEditModalOpen}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div className="absolute right-0 top-0 pr-4 pt-4">
                    <button
                      type="button"
                      className="rounded-md bg-white text-gray-400 hover:text-gray-500"
                      onClick={() => setIsEditModalOpen(false)}
                    >
                      <span className="sr-only">Close</span>
                      <XMarkIcon className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="sm:flex sm:items-start">
                    <div className="mt-3 text-center sm:mt-0 sm:text-left w-full">
                      <Dialog.Title as="h3" className="text-lg font-semibold leading-6 text-gray-900">
                        Edit Spare Part
                      </Dialog.Title>
                      <p className="mt-2 text-sm text-gray-500">
                        {selectedSpare?.serno} - {selectedSpare?.part_name}
                      </p>

                      {modalError && (
                        <div className="mt-4 rounded-md bg-red-50 p-4">
                          <p className="text-sm text-red-800">{modalError}</p>
                        </div>
                      )}

                      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
                        {/* Status */}
                        <div>
                          <label htmlFor="status_cd" className="block text-sm font-medium text-gray-700">
                            Status *
                          </label>
                          <select
                            id="status_cd"
                            {...register('status_cd')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          >
                            <option value="">Select status</option>
                            {assetStatuses.map((status) => (
                              <option key={status.status_cd} value={status.status_cd}>
                                {status.status_name}
                              </option>
                            ))}
                          </select>
                          {errors.status_cd && (
                            <p className="mt-1 text-sm text-red-600">{errors.status_cd.message}</p>
                          )}
                        </div>

                        {/* Assigned Base */}
                        <div>
                          <label htmlFor="admin_loc" className="block text-sm font-medium text-gray-700">
                            <span className="flex items-center gap-1">
                              Assigned Base *
                              <QuestionMarkCircleIcon
                                className="h-4 w-4 text-gray-400 cursor-help"
                                title="Assigned Base indicates which organization owns this asset"
                              />
                            </span>
                          </label>
                          <select
                            id="admin_loc"
                            {...register('admin_loc')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          >
                            <option value="">Select location</option>
                            {adminLocations.map((loc) => (
                              <option key={loc.loc_cd} value={loc.loc_cd}>
                                {loc.loc_name}
                              </option>
                            ))}
                          </select>
                          {errors.admin_loc && (
                            <p className="mt-1 text-sm text-red-600">{errors.admin_loc.message}</p>
                          )}
                        </div>

                        {/* Current Base */}
                        <div>
                          <label htmlFor="cust_loc" className="block text-sm font-medium text-gray-700">
                            <span className="flex items-center gap-1">
                              Current Base *
                              <QuestionMarkCircleIcon
                                className="h-4 w-4 text-gray-400 cursor-help"
                                title="Current Base indicates where this asset is physically located"
                              />
                            </span>
                          </label>
                          <select
                            id="cust_loc"
                            {...register('cust_loc')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          >
                            <option value="">Select location</option>
                            {custodialLocations.sort(compareLocations).map((loc) => (
                              <option key={loc.loc_id} value={loc.loc_id.toString()}>
                                {formatLocationHierarchical(loc)}
                              </option>
                            ))}
                          </select>
                          {errors.cust_loc && (
                            <p className="mt-1 text-sm text-red-600">{errors.cust_loc.message}</p>
                          )}
                        </div>

                        {/* Notes */}
                        <div>
                          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
                            Notes
                          </label>
                          <textarea
                            id="notes"
                            rows={3}
                            {...register('notes')}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                          />
                          {errors.notes && (
                            <p className="mt-1 text-sm text-red-600">{errors.notes.message}</p>
                          )}
                        </div>

                        <div className="mt-6 sm:flex sm:flex-row-reverse gap-3">
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            className="inline-flex w-full justify-center rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto"
                          >
                            {isSubmitting ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditModalOpen(false)}
                            disabled={isSubmitting}
                            className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Delete Confirmation Modal */}
      <Transition.Root show={isDeleteModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsDeleteModalOpen}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div className="sm:flex sm:items-start">
                    <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                      <ExclamationTriangleIcon className="h-6 w-6 text-red-600" />
                    </div>
                    <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
                      <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                        Delete Spare Part
                      </Dialog.Title>
                      <div className="mt-2">
                        <p className="text-sm text-gray-500">
                          Are you sure you want to delete <span className="font-semibold">{selectedSpare?.serno}</span> ({selectedSpare?.part_name})?
                        </p>
                        <p className="text-sm text-red-600 font-medium mt-2">
                          ⚠️ This will PERMANENTLY delete the spare from the database. This action cannot be undone.
                        </p>
                      </div>

                      {modalError && (
                        <div className="mt-4 rounded-md bg-red-50 p-4">
                          <p className="text-sm text-red-800">{modalError}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse gap-3">
                    <button
                      type="button"
                      onClick={handleDeleteConfirm}
                      disabled={isDeleting}
                      className="inline-flex w-full justify-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto"
                    >
                      {isDeleting ? 'Deleting...' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsDeleteModalOpen(false)}
                      disabled={isDeleting}
                      className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
                    >
                      Cancel
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Mass Update Modal */}
      <Transition.Root show={isMassUpdateModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsMassUpdateModalOpen}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div>
                    <div className="mt-3 text-center sm:mt-0 sm:text-left">
                      <Dialog.Title as="h3" className="text-lg font-semibold leading-6 text-gray-900 mb-4">
                        Mass Update Spares
                      </Dialog.Title>

                      <div className="mb-4">
                        <p className="text-sm text-gray-600">
                          You are updating <span className="font-semibold">{selectedSpareIds.length}</span> spare part(s)
                        </p>
                      </div>

                      <div className="space-y-4">
                        {/* Field Selector */}
                        <div>
                          <label htmlFor="mass-update-field" className="block text-sm font-medium text-gray-700 mb-1">
                            Field to Update
                          </label>
                          <select
                            id="mass-update-field"
                            value={massUpdateField}
                            onChange={(e) => {
                              setMassUpdateField(e.target.value)
                              setMassUpdateValue('')
                            }}
                            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                          >
                            <option value="status_cd">Status</option>
                            <option value="admin_loc">Assigned Base</option>
                            <option value="cust_loc">Current Base</option>
                          </select>
                        </div>

                        {/* Value Input */}
                        <div>
                          <label htmlFor="mass-update-value" className="block text-sm font-medium text-gray-700 mb-1">
                            New Value
                          </label>
                          {massUpdateField === 'status_cd' ? (
                            <select
                              id="mass-update-value"
                              value={massUpdateValue}
                              onChange={(e) => setMassUpdateValue(e.target.value)}
                              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            >
                              <option value="">Select Status</option>
                              {assetStatuses.map((status) => (
                                <option key={status.status_cd} value={status.status_cd}>
                                  {status.status_cd} - {status.status_name}
                                </option>
                              ))}
                            </select>
                          ) : massUpdateField === 'admin_loc' ? (
                            <select
                              id="mass-update-value"
                              value={massUpdateValue}
                              onChange={(e) => setMassUpdateValue(e.target.value)}
                              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            >
                              <option value="">Select Location</option>
                              {adminLocations.map((loc) => (
                                <option key={loc.loc_id} value={loc.loc_cd}>
                                  {loc.loc_name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <select
                              id="mass-update-value"
                              value={massUpdateValue}
                              onChange={(e) => setMassUpdateValue(e.target.value)}
                              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            >
                              <option value="">Select Location</option>
                              {custodialLocations.map((loc) => (
                                <option key={loc.loc_id} value={loc.loc_cd}>
                                  {loc.loc_name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>

                        {massUpdateError && (
                          <div className="rounded-md bg-red-50 p-4">
                            <p className="text-sm text-red-800">{massUpdateError}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 sm:mt-6 sm:flex sm:flex-row-reverse gap-3">
                    <button
                      type="button"
                      onClick={handleMassUpdateSubmit}
                      disabled={isMassUpdating || !massUpdateValue}
                      className="inline-flex w-full justify-center rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto"
                    >
                      {isMassUpdating ? 'Updating...' : 'Update All'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsMassUpdateModalOpen(false)}
                      disabled={isMassUpdating}
                      className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
                    >
                      Cancel
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Bulk Delete Confirmation Modal 1 (First Confirmation) */}
      <Transition.Root show={isBulkDeleteConfirm1Open} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsBulkDeleteConfirm1Open}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div className="sm:flex sm:items-start">
                    <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                      <ExclamationTriangleIcon className="h-6 w-6 text-red-600" />
                    </div>
                    <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
                      <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                        Bulk Delete Spares
                      </Dialog.Title>
                      <div className="mt-2">
                        <p className="text-sm text-gray-500">
                          You are about to delete <span className="font-semibold">{selectedSpareIds.length}</span> spare part(s).
                        </p>
                        <p className="text-sm text-gray-500 mt-2">
                          Are you sure you want to proceed? This action requires a second confirmation.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse gap-3">
                    <button
                      type="button"
                      onClick={handleBulkDeleteConfirm1}
                      className="inline-flex w-full justify-center rounded-md bg-orange-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 sm:w-auto"
                    >
                      Continue
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsBulkDeleteConfirm1Open(false)}
                      className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 sm:mt-0 sm:w-auto"
                    >
                      Cancel
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Bulk Delete Confirmation Modal 2 (Second Confirmation with Count) */}
      <Transition.Root show={isBulkDeleteConfirm2Open} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setIsBulkDeleteConfirm2Open}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                  <div className="sm:flex sm:items-start">
                    <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                      <ExclamationTriangleIcon className="h-6 w-6 text-red-600" />
                    </div>
                    <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
                      <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                        Final Confirmation - Bulk Delete
                      </Dialog.Title>
                      <div className="mt-2">
                        <p className="text-sm text-gray-500">
                          <span className="font-semibold text-red-600">FINAL WARNING:</span> You are about to permanently delete{' '}
                          <span className="font-bold text-red-700">{selectedSpareIds.length}</span> spare part(s).
                        </p>
                        <p className="text-sm text-gray-500 mt-2">
                          This is a soft delete - the spares can be recovered if needed. Click "Delete All" to proceed or "Cancel" to abort.
                        </p>
                      </div>

                      {bulkDeleteError && (
                        <div className="mt-4 rounded-md bg-red-50 p-4">
                          <p className="text-sm text-red-800">{bulkDeleteError}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse gap-3">
                    <button
                      type="button"
                      onClick={handleBulkDeleteConfirm2}
                      disabled={isBulkDeleting}
                      className="inline-flex w-full justify-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto"
                    >
                      {isBulkDeleting ? 'Deleting...' : 'Delete All'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsBulkDeleteConfirm2Open(false)}
                      disabled={isBulkDeleting}
                      className="mt-3 inline-flex w-full justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
                    >
                      Cancel
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>
    </div>
  )
}
