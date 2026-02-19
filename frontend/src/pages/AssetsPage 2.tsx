import { useState, useEffect, useCallback, Fragment } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Dialog, Transition } from '@headlessui/react'
import {
  PlusIcon,
  XMarkIcon,
  CubeIcon,
  TrashIcon,
  ExclamationTriangleIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronUpDownIcon,
  DocumentArrowDownIcon,
} from '@heroicons/react/24/outline'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { useUnsavedChangesWarning } from '../hooks/useUnsavedChangesWarning'
import LoadingSpinner from '../components/LoadingSpinner'
import { useToast } from '../hooks/useToast'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'

// Reference data interfaces
interface Location {
  loc_id: number
  loc_cd: string
  loc_name: string
}

interface AssetStatus {
  status_cd: string
  status_name: string
  description: string
}

// Zod schema for asset creation
const createAssetSchema = z.object({
  partno: z.string()
    .trim()
    .min(1, 'Part number is required')
    .max(50, 'Part number must be at most 50 characters')
    .regex(/^[A-Za-z0-9\-_]+$/, 'Part number can only contain letters, numbers, hyphens, and underscores'),
  serno: z.string()
    .trim()
    .min(1, 'Serial number is required')
    .max(50, 'Serial number must be at most 50 characters'),
  name: z.string()
    .trim()
    .max(100, 'Name must be at most 100 characters')
    .optional()
    .or(z.literal('')),
  status_cd: z.string().trim().min(1, 'Status is required'),
  admin_loc: z.string().trim().min(1, 'Assigned base is required'),
  cust_loc: z.string().trim().min(1, 'Current base is required'),
  notes: z.string().trim().max(500, 'Notes must be at most 500 characters').optional().or(z.literal('')),
})

type CreateAssetFormData = z.infer<typeof createAssetSchema>

// Asset interface matching backend
interface Asset {
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
  in_transit: boolean
  bad_actor: boolean
  last_maint_date: string | null
  next_pmi_date: string | null
  eti_hours: number | null
  remarks: string | null
}

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

interface AssetsResponse {
  assets: Asset[]
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

export default function AssetsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { token, currentProgramId, user } = useAuthStore()
  const { showSuccess, showError } = useToast()
  const queryClient = useQueryClient()

  // Check if user can create assets
  const canCreateAsset = user && ['ADMIN', 'DEPOT_MANAGER'].includes(user.role)
  // Check if user can delete assets (only admins)
  const canDeleteAsset = user && user.role === 'ADMIN'

  // Page state (not managed by React Query)
  const [currentPage, setCurrentPage] = useState(1)

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)

  // Delete confirmation modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Reference data for form
  const [adminLocations, setAdminLocations] = useState<Location[]>([])
  const [custodialLocations, setCustodialLocations] = useState<Location[]>([])
  const [assetStatuses, setAssetStatuses] = useState<AssetStatus[]>([])

  // Filters - Initialize from URL search params
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '')
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get('status') || '')
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get('search') || '')

  // Sorting
  type SortColumn = 'serno' | 'partno' | 'part_name' | 'status_cd' | 'location' | 'eti_hours' | 'next_pmi_date'
  type SortOrder = 'asc' | 'desc'
  const [sortBy, setSortBy] = useState<SortColumn>('serno')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  // Form setup
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CreateAssetFormData>({
    resolver: zodResolver(createAssetSchema),
    defaultValues: {
      partno: '',
      serno: '',
      name: '',
      status_cd: 'FMC', // Default to Fully Mission Capable
      admin_loc: 'DEPOT-A', // Default to first depot location (Depot Alpha)
      cust_loc: 'MAINT-BAY-1', // Default to first maintenance location (Maintenance Bay 1)
      notes: '',
    },
  })

  // Warn user about unsaved changes on page refresh/close
  useUnsavedChangesWarning(isDirty && isModalOpen)

  // Handler to update search query and URL
  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    const newParams = new URLSearchParams(searchParams)
    if (value) {
      newParams.set('search', value)
    } else {
      newParams.delete('search')
    }
    setSearchParams(newParams, { replace: true })
  }

  // Handler to update status filter and URL
  const handleStatusChange = (value: string) => {
    setStatusFilter(value)
    const newParams = new URLSearchParams(searchParams)
    if (value) {
      newParams.set('status', value)
    } else {
      newParams.delete('status')
    }
    setSearchParams(newParams, { replace: true })
  }

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 150)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // React Query: Fetch assets with automatic caching and invalidation
  const {
    data: assetsData,
    isLoading: loading,
    error: queryError,
    refetch: refetchAssets,
  } = useQuery<AssetsResponse, Error>({
    queryKey: ['assets', currentProgramId, currentPage, statusFilter, debouncedSearch, sortBy, sortOrder],
    queryFn: async () => {
      if (!token) throw new Error('No authentication token')

      const params = new URLSearchParams()
      if (currentProgramId) params.append('program_id', currentProgramId.toString())
      params.append('page', currentPage.toString())
      params.append('limit', '10')
      if (statusFilter) params.append('status', statusFilter)
      if (debouncedSearch) params.append('search', debouncedSearch)
      params.append('sort_by', sortBy)
      params.append('sort_order', sortOrder)

      const response = await fetch(`/api/assets?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to fetch assets')
      }

      return response.json()
    },
    enabled: !!token, // Only run query if token exists
  })

  // Extract data from React Query result
  const assets = assetsData?.assets || []
  const pagination = assetsData?.pagination || { page: 1, limit: 10, total: 0, total_pages: 1 }
  const program = assetsData?.program || null
  const error = queryError?.message || null

  // React Query: Create asset mutation
  const createAssetMutation = useMutation({
    mutationFn: async (data: CreateAssetFormData) => {
      const response = await fetch('/api/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...data,
          pgm_id: currentProgramId || 1,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create asset')
      }

      return response.json()
    },
    onSuccess: (result) => {
      showSuccess(`Asset "${result.asset.serno}" created successfully!`)
      setIsModalOpen(false)
      reset()
      setCurrentPage(1) // Reset to first page
      // Invalidate and refetch assets
      queryClient.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: (error: Error) => {
      setModalError(error.message)
    },
  })

  // React Query: Delete asset mutation (soft delete)
  const deleteAssetMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const response = await fetch(`/api/assets/${assetId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete asset')
      }

      return response.json()
    },
    onSuccess: (result, assetId) => {
      const asset = assets.find(a => a.asset_id === assetId)
      showSuccess(result.message || `Asset "${asset?.serno}" deleted successfully!`)
      closeDeleteModal()
      // Invalidate and refetch assets - THIS IS THE KEY FIX FOR FEATURE #283
      queryClient.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: (error: Error) => {
      setDeleteError(error.message)
    },
  })

  // React Query: Permanent delete asset mutation
  const permanentDeleteAssetMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const response = await fetch(`/api/assets/${assetId}/permanent`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to permanently delete asset')
      }

      return response.json()
    },
    onSuccess: (result, assetId) => {
      const asset = assets.find(a => a.asset_id === assetId)
      showSuccess(result.message || `Asset "${asset?.serno}" permanently deleted!`)
      closeDeleteModal()
      // Invalidate and refetch assets - THIS IS THE KEY FIX FOR FEATURE #283
      queryClient.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: (error: Error) => {
      setDeleteError(error.message)
    },
  })

  // Fetch reference data for form
  const fetchReferenceData = useCallback(async () => {
    if (!token) return

    try {
      const [locResponse, statusResponse] = await Promise.all([
        fetch('/api/reference/locations', {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
        fetch('/api/reference/asset-statuses', {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      ])

      if (locResponse.ok) {
        const locData = await locResponse.json()
        setAdminLocations(locData.admin_locations || [])
        setCustodialLocations(locData.custodial_locations || [])
      }

      if (statusResponse.ok) {
        const statusData = await statusResponse.json()
        setAssetStatuses(statusData.statuses || [])
      }
    } catch (err) {
      console.error('Error fetching reference data:', err)
    }
  }, [token])

  // Fetch reference data on mount
  useEffect(() => {
    fetchReferenceData()
  }, [fetchReferenceData])

  // Handle page change
  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.total_pages) {
      setCurrentPage(newPage)
    }
  }

  // Handle form submission using React Query mutation
  const onSubmit = async (data: CreateAssetFormData) => {
    setModalError(null)
    createAssetMutation.mutate(data)
  }

  // Modal handlers
  const openModal = () => {
    reset()
    setModalError(null)
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    reset()
    setModalError(null)
  }

  // Delete modal handlers
  const openDeleteModal = (asset: Asset) => {
    setAssetToDelete(asset)
    setDeleteError(null)
    setIsDeleteModalOpen(true)
  }

  const closeDeleteModal = () => {
    setIsDeleteModalOpen(false)
    setAssetToDelete(null)
    setDeleteError(null)
  }

  const handleDeleteAsset = () => {
    if (!assetToDelete) return
    setDeleteError(null)
    deleteAssetMutation.mutate(assetToDelete.asset_id)
  }

  const handlePermanentDeleteAsset = () => {
    if (!assetToDelete) return
    setDeleteError(null)
    permanentDeleteAssetMutation.mutate(assetToDelete.asset_id)
  }

  // Track deleting state from mutations
  const isDeleting = deleteAssetMutation.isPending || permanentDeleteAssetMutation.isPending

  // Format date for display
  const formatDate = (dateString: string | null): string => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  // Get current ZULU (UTC) timestamp
  const getZuluTimestamp = (): string => {
    const now = new Date()
    return now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
  }

  // Get ZULU date for filename
  const getZuluDateForFilename = (): string => {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    return `${year}${month}${day}`
  }

  // Export assets to PDF with CUI markings
  const exportToPdf = async () => {
    try {
      // Fetch ALL assets for export (not just current page)
      const params = new URLSearchParams()
      if (currentProgramId) params.append('program_id', currentProgramId.toString())
      params.append('page', '1')
      params.append('limit', '999999') // Fetch all records
      if (statusFilter) params.append('status', statusFilter)
      if (debouncedSearch) params.append('search', debouncedSearch)
      params.append('sort_by', sortBy)
      params.append('sort_order', sortOrder)

      const response = await fetch(`/api/assets?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        showError('Failed to fetch assets for export')
        return
      }

      const data: AssetsResponse = await response.json()
      const allAssets = data.assets

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

        // Timestamp on footer
        doc.text(`Generated: ${zuluTimestamp}`, 15, pageHeight - 5, { align: 'left' })
      }

      // Add title section after header
      const addTitle = () => {
        doc.setFontSize(16)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(30, 64, 175) // Primary blue
        doc.text('ACSS Asset Report', pageWidth / 2, 20, { align: 'center' })

        doc.setFontSize(11)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(55, 65, 81) // Gray
        const programText = program ? `Program: ${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'
        doc.text(programText, pageWidth / 2, 27, { align: 'center' })

        doc.setFontSize(9)
        doc.text(`Report generated: ${zuluTimestamp}`, pageWidth / 2, 33, { align: 'center' })
        doc.text(`Total Assets: ${data.pagination.total}`, pageWidth / 2, 38, { align: 'center' })

        // Add filter info if applied
        if (statusFilter || debouncedSearch) {
          const filters: string[] = []
          if (statusFilter) filters.push(`Status: ${statusFilter}`)
          if (debouncedSearch) filters.push(`Search: "${debouncedSearch}"`)
          doc.setFontSize(8)
          doc.setTextColor(107, 114, 128)
          doc.text(`Filters: ${filters.join(', ')}`, pageWidth / 2, 43, { align: 'center' })
        }
      }

      // Prepare table data from ALL assets
      const tableData = allAssets.map(asset => [
        asset.serno + (asset.bad_actor ? ' (BA)' : '') + (asset.in_transit ? ' (Transit)' : ''),
        asset.partno,
        asset.part_name,
        asset.status_cd,
        asset.location,
        asset.eti_hours != null ? asset.eti_hours.toLocaleString() : '-',
        formatDate(asset.next_pmi_date)
      ])

      // Add header to first page
      addCuiHeader()
      addTitle()

      // Generate table with autoTable
      autoTable(doc, {
        startY: statusFilter || debouncedSearch ? 48 : 43,
        head: [['Serial Number', 'Part Number', 'Name', 'Status', 'Location', 'ETI Hours', 'Next PMI']],
        body: tableData,
      theme: 'striped',
      headStyles: {
        fillColor: [30, 64, 175], // Primary blue
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 9
      },
      bodyStyles: {
        fontSize: 8,
        textColor: [55, 65, 81]
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] // Light gray
      },
      margin: { top: 15, bottom: 15, left: 10, right: 10 },
      didDrawPage: (data) => {
        // Add CUI header on each page
        addCuiHeader()

        // If this is not the first page, we don't have title space
        if (data.pageNumber > 1) {
          // Adjust starting position for subsequent pages
        }
      },
      // Style specific columns
      columnStyles: {
        0: { cellWidth: 40 }, // Serial Number
        1: { cellWidth: 35 }, // Part Number
        2: { cellWidth: 55 }, // Name
        3: { cellWidth: 20 }, // Status
        4: { cellWidth: 45 }, // Location
        5: { cellWidth: 25 }, // ETI Hours
        6: { cellWidth: 30 }, // Next PMI
      }
      })

      // Get total pages and add footers
      const totalPages = doc.getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        addCuiFooter(i, totalPages)
      }

      // Generate filename with CUI prefix and ZULU date
      const filename = `CUI_Assets_${getZuluDateForFilename()}.pdf`

      // Save the PDF
      doc.save(filename)
    } catch (error) {
      showError('Failed to export PDF')
      console.error('PDF export error:', error)
    }
  }

  // Export assets to Excel with CUI markings
  const exportToExcel = async () => {
    try {
      // Fetch ALL assets for export (not just current page)
      const params = new URLSearchParams()
      if (currentProgramId) params.append('program_id', currentProgramId.toString())
      params.append('page', '1')
      params.append('limit', '999999') // Fetch all records
      if (statusFilter) params.append('status', statusFilter)
      if (debouncedSearch) params.append('search', debouncedSearch)
      params.append('sort_by', sortBy)
      params.append('sort_order', sortOrder)

      const response = await fetch(`/api/assets?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        showError('Failed to fetch assets for export')
        return
      }

      const data: AssetsResponse = await response.json()
      const allAssets = data.assets

      const zuluTimestamp = getZuluTimestamp()

      // Create workbook and worksheet
      const wb = XLSX.utils.book_new()

      // Prepare data rows with CUI header
      const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
      const blankRow: string[] = []
      const reportInfoRow1 = [`ACSS Asset Report - ${program ? `${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'}`]
      const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
      const reportInfoRow3 = [`Total Assets: ${data.pagination.total}`]
      const filterRow = statusFilter || debouncedSearch
        ? [`Filters: ${[statusFilter ? `Status: ${statusFilter}` : '', debouncedSearch ? `Search: "${debouncedSearch}"` : ''].filter(Boolean).join(', ')}`]
        : []

      // Table header row
      const headerRow = ['Serial Number', 'Part Number', 'Name', 'Status', 'Status Name', 'Location', 'Location Type', 'ETI Hours', 'Next PMI Date', 'Bad Actor', 'In Transit', 'Remarks']

      // Data rows from ALL assets
      const dataRows = allAssets.map(asset => [
        asset.serno,
        asset.partno,
        asset.part_name,
        asset.status_cd,
        asset.status_name,
        asset.location,
        asset.loc_type,
        asset.eti_hours !== null ? asset.eti_hours : '',
        asset.next_pmi_date ? formatDate(asset.next_pmi_date) : '',
        asset.bad_actor ? 'Yes' : 'No',
        asset.in_transit ? 'Yes' : 'No',
        asset.remarks || ''
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
        { wch: 15 },  // Part Number
        { wch: 25 },  // Name
        { wch: 8 },   // Status
        { wch: 30 },  // Status Name
        { wch: 20 },  // Location
        { wch: 12 },  // Location Type
        { wch: 12 },  // ETI Hours
        { wch: 14 },  // Next PMI Date
        { wch: 10 },  // Bad Actor
        { wch: 10 },  // In Transit
        { wch: 40 },  // Remarks
      ]

      // Merge CUI header cells across all columns
      const numCols = headerRow.length
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
        { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
        { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
        { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Total assets
        { s: { r: allRows.length - 1, c: 0 }, e: { r: allRows.length - 1, c: numCols - 1 } }, // CUI footer
      ]

      // Add filter merge if applicable
      if (filterRow.length) {
        ws['!merges']!.push({ s: { r: 5, c: 0 }, e: { r: 5, c: numCols - 1 } })
      }

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(wb, ws, 'Assets')

      // Generate filename with CUI prefix and ZULU date
      const filename = `CUI_Assets_${getZuluDateForFilename()}.xlsx`

      // Write the file and trigger download
      XLSX.writeFile(wb, filename)
    } catch (error) {
      showError('Failed to export Excel')
      console.error('Excel export error:', error)
    }
  }

  // Handle column sorting
  const handleSort = (column: SortColumn) => {
    if (sortBy === column) {
      // Toggle order if same column
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      // New column, start with ascending
      setSortBy(column)
      setSortOrder('asc')
    }
  }

  // Sortable column header component
  const SortableHeader = ({
    column,
    label
  }: {
    column: SortColumn
    label: string
  }) => {
    const isActive = sortBy === column
    return (
      <button
        type="button"
        onClick={() => handleSort(column)}
        className="group inline-flex items-center gap-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hover:text-gray-700 min-h-[44px] py-2"
      >
        {label}
        <span className="flex-none">
          {isActive ? (
            sortOrder === 'asc' ? (
              <ChevronUpIcon className="h-4 w-4 text-primary-500" />
            ) : (
              <ChevronDownIcon className="h-4 w-4 text-primary-500" />
            )
          ) : (
            <ChevronUpDownIcon className="h-4 w-4 text-gray-400 group-hover:text-gray-500" />
          )}
        </span>
      </button>
    )
  }

  // Get status badge
  const StatusBadge = ({ status, statusName }: { status: string; statusName: string }) => {
    const colors = statusColors[status] || { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-200' }
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text} border ${colors.border}`}>
        {status}
        <span className="sr-only"> - {statusName}</span>
      </span>
    )
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="sm:flex sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Assets</h1>
          <p className="mt-1 text-sm text-gray-500">
            {program ? `Viewing assets for ${program.pgm_cd} - ${program.pgm_name}` : 'Loading...'}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center gap-4">
          <span className="text-sm text-gray-500">
            {pagination.total} total asset{pagination.total !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={exportToPdf}
            disabled={assets.length === 0}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export to PDF with CUI markings"
          >
            <DocumentArrowDownIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
            Export PDF
          </button>
          <button
            type="button"
            onClick={exportToExcel}
            disabled={assets.length === 0}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export to Excel with CUI markings"
          >
            <svg className="-ml-1 mr-2 h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Export Excel
          </button>
          {canCreateAsset && (
            <button
              type="button"
              onClick={openModal}
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
              Add Asset
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white shadow rounded-lg p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* Search */}
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-gray-700">
              Search
            </label>
            <div className="mt-1 relative rounded-md shadow-sm">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                id="search"
                className="focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 sm:text-sm border-gray-300 rounded-md"
                placeholder="Search by S/N, P/N, or name..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label htmlFor="status" className="block text-sm font-medium text-gray-700">
              Status
            </label>
            <select
              id="status"
              className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
              value={statusFilter}
              onChange={(e) => handleStatusChange(e.target.value)}
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

          {/* Refresh Button */}
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => refetchAssets()}
              className="inline-flex items-center px-4 py-3 min-h-[44px] border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="ml-3">
              <p className="text-sm font-medium text-red-800">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Assets Table */}
      <div className="bg-white shadow rounded-lg overflow-y-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center">
              <LoadingSpinner size="md" className="text-primary-600" />
              <p className="mt-2 text-sm text-gray-500">Loading assets...</p>
            </div>
          </div>
        ) : assets.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className="mt-2 text-sm text-gray-500">No assets found</p>
              <p className="text-xs text-gray-400">Try adjusting your filters</p>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="serno" label="Serial Number" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="partno" label="Part Number" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="part_name" label="Name" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="status_cd" label="Status" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="location" label="Location" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="eti_hours" label="ETI Hours" />
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">
                      <SortableHeader column="next_pmi_date" label="Next PMI" />
                    </th>
                    <th scope="col" className="relative px-6 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {assets.map((asset) => (
                    <tr
                      key={asset.asset_id}
                      className={`hover:bg-gray-50 ${asset.bad_actor ? 'bg-red-50' : ''}`}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center">
                          <div className="text-sm font-medium text-gray-900 truncate max-w-xs" title={asset.serno}>
                            {asset.serno}
                          </div>
                          {asset.bad_actor && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 flex-shrink-0" title="Bad Actor">
                              BA
                            </span>
                          )}
                          {asset.in_transit && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 flex-shrink-0" title="In Transit">
                              Transit
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {asset.partno}
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900 truncate max-w-xs" title={asset.part_name}>
                          {asset.part_name}
                        </div>
                        {asset.remarks && (
                          <div className="text-xs text-gray-500 truncate max-w-xs" title={asset.remarks}>
                            {asset.remarks}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={asset.status_cd} statusName={asset.status_name} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{asset.location}</div>
                        <div className="text-xs text-gray-500 capitalize">{asset.loc_type}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {asset.eti_hours != null ? asset.eti_hours.toLocaleString() : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(asset.next_pmi_date)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-3">
                          <button
                            onClick={() => {
                              // Save current filters to sessionStorage before navigating
                              const currentFilters = searchParams.toString()
                              if (currentFilters) {
                                sessionStorage.setItem('assetsPageFilters', currentFilters)
                              } else {
                                sessionStorage.removeItem('assetsPageFilters')
                              }
                              navigate(`/assets/${asset.asset_id}`)
                            }}
                            className="text-primary-600 hover:text-primary-900 min-h-[44px] min-w-[44px] flex items-center justify-center"
                          >
                            View
                          </button>
                          {canDeleteAsset && (
                            <button
                              onClick={() => openDeleteModal(asset)}
                              className="text-red-600 hover:text-red-900 min-h-[44px] min-w-[44px] flex items-center justify-center"
                              title="Delete asset"
                            >
                              <TrashIcon className="h-5 w-5" aria-hidden="true" />
                              <span className="sr-only">Delete {asset.serno}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.total_pages > 1 && (
              <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
                <div className="flex-1 flex justify-between sm:hidden">
                  <button
                    onClick={() => handlePageChange(pagination.page - 1)}
                    disabled={pagination.page === 1}
                    className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => handlePageChange(pagination.page + 1)}
                    disabled={pagination.page === pagination.total_pages}
                    className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
                <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm text-gray-700">
                      Showing <span className="font-medium">{(pagination.page - 1) * pagination.limit + 1}</span> to{' '}
                      <span className="font-medium">
                        {Math.min(pagination.page * pagination.limit, pagination.total)}
                      </span>{' '}
                      of <span className="font-medium">{pagination.total}</span> results
                    </p>
                  </div>
                  <div>
                    <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                      <button
                        onClick={() => handlePageChange(pagination.page - 1)}
                        disabled={pagination.page === 1}
                        className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="sr-only">Previous</span>
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </button>
                      {/* Page numbers */}
                      {Array.from({ length: pagination.total_pages }, (_, i) => i + 1).map((pageNum) => (
                        <button
                          key={pageNum}
                          onClick={() => handlePageChange(pageNum)}
                          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                            pageNum === pagination.page
                              ? 'z-10 bg-primary-50 border-primary-500 text-primary-600'
                              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {pageNum}
                        </button>
                      ))}
                      <button
                        onClick={() => handlePageChange(pagination.page + 1)}
                        disabled={pagination.page === pagination.total_pages}
                        className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="sr-only">Next</span>
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </nav>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Legend */}
      <div className="bg-white shadow rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Status Legend</h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center">
            <StatusBadge status="FMC" statusName="Fully Mission Capable" />
            <span className="ml-2 text-xs text-gray-500">Fully Mission Capable</span>
          </div>
          <div className="flex items-center">
            <StatusBadge status="PMC" statusName="Partially Mission Capable" />
            <span className="ml-2 text-xs text-gray-500">Partially Mission Capable</span>
          </div>
          <div className="flex items-center">
            <StatusBadge status="NMCM" statusName="Not Mission Capable Maintenance" />
            <span className="ml-2 text-xs text-gray-500">Not Mission Capable (Maint)</span>
          </div>
          <div className="flex items-center">
            <StatusBadge status="NMCS" statusName="Not Mission Capable Supply" />
            <span className="ml-2 text-xs text-gray-500">Not Mission Capable (Supply)</span>
          </div>
          <div className="flex items-center">
            <StatusBadge status="CNDM" statusName="Condemned" />
            <span className="ml-2 text-xs text-gray-500">Condemned</span>
          </div>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-gray-500">
          <div className="flex items-center">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">BA</span>
            <span className="ml-1">= Bad Actor (chronic failures)</span>
          </div>
          <div className="flex items-center">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">Transit</span>
            <span className="ml-1">= In Transit</span>
          </div>
        </div>
      </div>

      {/* Add Asset Modal */}
      <Transition appear show={isModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={closeModal}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-25" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-lg transform overflow-hidden rounded-2xl bg-white text-left align-middle shadow-xl transition-all flex flex-col max-h-[90vh]">
                  {/* Fixed Header */}
                  <div className="px-6 pt-6 pb-4 border-b border-gray-200">
                    <Dialog.Title
                      as="h3"
                      className="text-lg font-medium leading-6 text-gray-900 flex items-center"
                    >
                      <CubeIcon className="h-6 w-6 mr-2 text-primary-600" />
                      Add New Asset
                    </Dialog.Title>

                    <button
                      type="button"
                      className="absolute top-4 right-4 text-gray-400 hover:text-gray-500"
                      onClick={closeModal}
                    >
                      <XMarkIcon className="h-6 w-6" />
                    </button>
                  </div>

                  {/* Scrollable Content */}
                  <div className="px-6 py-4 overflow-y-auto flex-1">
                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" id="add-asset-form">
                    {/* Error display inside modal */}
                    {modalError && (
                      <div className="rounded-md bg-red-50 p-3">
                        <p className="text-sm text-red-800">{modalError}</p>
                      </div>
                    )}

                    {/* Part Number */}
                    <div>
                      <label htmlFor="partno" className="block text-sm font-medium text-gray-700">
                        Part Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        id="partno"
                        {...register('partno')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.partno
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        placeholder="PN-SENSOR-A"
                        aria-invalid={errors.partno ? 'true' : 'false'}
                        aria-describedby={errors.partno ? 'partno-error' : undefined}
                      />
                      {errors.partno && (
                        <p id="partno-error" className="mt-1 text-sm text-red-600" role="alert">{errors.partno.message}</p>
                      )}
                    </div>

                    {/* Serial Number */}
                    <div>
                      <label htmlFor="serno" className="block text-sm font-medium text-gray-700">
                        Serial Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        id="serno"
                        {...register('serno')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.serno
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        placeholder="CRIIS-011"
                        aria-invalid={errors.serno ? 'true' : 'false'}
                        aria-describedby={errors.serno ? 'serno-error' : undefined}
                      />
                      {errors.serno && (
                        <p id="serno-error" className="mt-1 text-sm text-red-600" role="alert">{errors.serno.message}</p>
                      )}
                    </div>

                    {/* Asset Name (optional) */}
                    <div>
                      <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                        Asset Name <span className="text-gray-400">(optional)</span>
                      </label>
                      <input
                        type="text"
                        id="name"
                        {...register('name')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.name
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        placeholder="Sensor Unit A-3"
                        aria-invalid={errors.name ? 'true' : 'false'}
                        aria-describedby={errors.name ? 'name-error' : undefined}
                      />
                      {errors.name && (
                        <p id="name-error" className="mt-1 text-sm text-red-600" role="alert">{errors.name.message}</p>
                      )}
                      <p className="mt-1 text-xs text-gray-500">
                        If not provided, a name will be generated from the part and serial number.
                      </p>
                    </div>

                    {/* Status */}
                    <div>
                      <label htmlFor="status_cd" className="block text-sm font-medium text-gray-700">
                        Status <span className="text-red-500">*</span>
                      </label>
                      <select
                        id="status_cd"
                        {...register('status_cd')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.status_cd
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        aria-invalid={errors.status_cd ? 'true' : 'false'}
                        aria-describedby={errors.status_cd ? 'status_cd-error' : undefined}
                      >
                        <option value="">Select a status...</option>
                        {assetStatuses.map((status) => (
                          <option key={status.status_cd} value={status.status_cd}>
                            {status.status_cd} - {status.status_name}
                          </option>
                        ))}
                      </select>
                      {errors.status_cd && (
                        <p id="status_cd-error" className="mt-1 text-sm text-red-600" role="alert">{errors.status_cd.message}</p>
                      )}
                    </div>

                    {/* Assigned Base */}
                    <div>
                      <label htmlFor="admin_loc" className="block text-sm font-medium text-gray-700">
                        Assigned Base <span className="text-red-500">*</span>
                      </label>
                      <select
                        id="admin_loc"
                        {...register('admin_loc')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.admin_loc
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        aria-invalid={errors.admin_loc ? 'true' : 'false'}
                        aria-describedby={errors.admin_loc ? 'admin_loc-error' : undefined}
                      >
                        <option value="">Select administrative location...</option>
                        {adminLocations.map((loc) => (
                          <option key={loc.loc_cd} value={loc.loc_cd}>
                            {loc.loc_name}
                          </option>
                        ))}
                      </select>
                      {errors.admin_loc && (
                        <p id="admin_loc-error" className="mt-1 text-sm text-red-600" role="alert">{errors.admin_loc.message}</p>
                      )}
                    </div>

                    {/* Current Base */}
                    <div>
                      <label htmlFor="cust_loc" className="block text-sm font-medium text-gray-700">
                        Current Base <span className="text-red-500">*</span>
                      </label>
                      <select
                        id="cust_loc"
                        {...register('cust_loc')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.cust_loc
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        aria-invalid={errors.cust_loc ? 'true' : 'false'}
                        aria-describedby={errors.cust_loc ? 'cust_loc-error' : undefined}
                      >
                        <option value="">Select custodial location...</option>
                        {custodialLocations.map((loc) => (
                          <option key={loc.loc_cd} value={loc.loc_cd}>
                            {loc.loc_name}
                          </option>
                        ))}
                      </select>
                      {errors.cust_loc && (
                        <p id="cust_loc-error" className="mt-1 text-sm text-red-600" role="alert">{errors.cust_loc.message}</p>
                      )}
                    </div>

                    {/* Notes */}
                    <div>
                      <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
                        Notes <span className="text-gray-400">(optional)</span>
                      </label>
                      <textarea
                        id="notes"
                        rows={3}
                        {...register('notes')}
                        className={`mt-1 block w-full rounded-md shadow-sm sm:text-sm ${
                          errors.notes
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                        }`}
                        placeholder="Any additional notes about this asset..."
                        aria-invalid={errors.notes ? 'true' : 'false'}
                        aria-describedby={errors.notes ? 'notes-error' : undefined}
                      />
                      {errors.notes && (
                        <p id="notes-error" className="mt-1 text-sm text-red-600" role="alert">{errors.notes.message}</p>
                      )}
                    </div>

                    </form>
                  </div>

                  {/* Fixed Footer */}
                  <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
                    <button
                      type="button"
                      onClick={closeModal}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => reset()}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
                    >
                      Reset
                    </button>
                    <button
                      type="submit"
                      form="add-asset-form"
                      disabled={isSubmitting}
                      className="inline-flex items-center justify-center rounded-md border border-transparent bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSubmitting ? (
                        <>
                          <LoadingSpinner size="sm" className="mr-2 text-white" />
                          Creating...
                        </>
                      ) : (
                        'Create Asset'
                      )}
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>

      {/* Delete Confirmation Modal */}
      <Transition appear show={isDeleteModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={closeDeleteModal}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-25" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                        <ExclamationTriangleIcon className="h-6 w-6 text-red-600" aria-hidden="true" />
                      </div>
                    </div>
                    <div className="ml-4">
                      <Dialog.Title
                        as="h3"
                        className="text-lg font-medium leading-6 text-gray-900"
                      >
                        Delete Asset
                      </Dialog.Title>
                      <div className="mt-2">
                        <p className="text-sm text-gray-500">
                          Choose how to delete this asset:
                        </p>
                        <div className="mt-2 bg-blue-50 rounded-md p-3 border border-blue-200">
                          <p className="text-sm text-blue-700 font-medium">Soft Delete (Recommended)</p>
                          <p className="text-xs text-blue-600 mt-1">Asset can be recovered later if needed</p>
                        </div>
                        <div className="mt-2 bg-red-50 rounded-md p-3 border border-red-200">
                          <p className="text-sm text-red-700 font-medium">Permanent Delete</p>
                          <p className="text-xs text-red-600 mt-1">⚠️ Asset will be COMPLETELY removed from the database - CANNOT BE RECOVERED</p>
                        </div>
                        {assetToDelete && (
                          <div className="mt-3 bg-gray-50 rounded-md p-3">
                            <dl className="text-sm">
                              <div className="flex justify-between py-1">
                                <dt className="font-medium text-gray-500">Serial Number:</dt>
                                <dd className="text-gray-900">{assetToDelete.serno}</dd>
                              </div>
                              <div className="flex justify-between py-1">
                                <dt className="font-medium text-gray-500">Part Number:</dt>
                                <dd className="text-gray-900">{assetToDelete.partno}</dd>
                              </div>
                              <div className="flex justify-between py-1">
                                <dt className="font-medium text-gray-500">Name:</dt>
                                <dd className="text-gray-900">{assetToDelete.part_name}</dd>
                              </div>
                              <div className="flex justify-between py-1">
                                <dt className="font-medium text-gray-500">Status:</dt>
                                <dd className="text-gray-900">{assetToDelete.status_cd}</dd>
                              </div>
                            </dl>
                          </div>
                        )}
                      </div>

                      {/* Error display */}
                      {deleteError && (
                        <div className="mt-3 rounded-md bg-red-50 p-3">
                          <p className="text-sm text-red-800">{deleteError}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 flex justify-end space-x-3">
                    <button
                      type="button"
                      onClick={closeDeleteModal}
                      disabled={isDeleting}
                      className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteAsset}
                      disabled={isDeleting}
                      className="inline-flex justify-center rounded-md border border-transparent bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDeleting ? 'Deleting...' : 'Soft Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={handlePermanentDeleteAsset}
                      disabled={isDeleting}
                      className="inline-flex justify-center rounded-md border border-transparent bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDeleting ? 'Deleting...' : 'Permanent Delete'}
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </div>
  )
}
