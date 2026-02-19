import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MagnifyingGlassIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  XMarkIcon,
  PencilIcon,
  TrashIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  DocumentArrowDownIcon,
} from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid'
import { Dialog } from '@headlessui/react'
import { useAuthStore } from '../stores/authStore'
import { SkeletonTable } from '../components/skeleton'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// Sortie interface matching backend
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

interface ProgramInfo {
  pgm_id: number
  pgm_cd: string
  pgm_name: string
}

interface SortiesResponse {
  sorties: Sortie[]
  total: number
}

interface Asset {
  asset_id: number
  serno: string
  partno: string
  name: string
  pgm_id: number
  status_cd: string
}

export default function SortiesPage() {
  const navigate = useNavigate()
  const { token, currentProgramId, user } = useAuthStore()

  // State
  const [sorties, setSorties] = useState<Sortie[]>([])
  const [filteredSorties, setFilteredSorties] = useState<Sortie[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [tailNumberFilter, setTailNumberFilter] = useState('')
  const [effectivenessFilter, setEffectivenessFilter] = useState('')

  // Add Sortie Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [assets, setAssets] = useState<Asset[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [newSortieForm, setNewSortieForm] = useState({
    asset_id: '',
    mission_id: '',
    sortie_date: new Date().toISOString().split('T')[0],
    sortie_effect: '',
    range: '',
    remarks: '',
  })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Edit Sortie Modal State
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingSortie, setEditingSortie] = useState<Sortie | null>(null)
  const [editSortieForm, setEditSortieForm] = useState({
    mission_id: '',
    sortie_date: '',
    sortie_effect: '',
    range: '',
    remarks: '',
  })

  // Review/Adjudication State
  const [activeTab, setActiveTab] = useState<'all' | 'pending'>('all')
  const [pendingSorties, setPendingSorties] = useState<Sortie[]>([])
  const [pendingTotal, setPendingTotal] = useState(0)
  const [pendingLoading, setPendingLoading] = useState(false)
  const [validating, setValidating] = useState<number | null>(null)
  const [adjudicating, setAdjudicating] = useState<number | null>(null)
  const [adjudicationNotes, setAdjudicationNotes] = useState('')

  // Delete Confirmation Dialog State
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [sortieToDelete, setSortieToDelete] = useState<Sortie | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Import Modal State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPreview, setImportPreview] = useState<any[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  const [importDuplicates, setImportDuplicates] = useState<any[]>([])
  const [duplicateAction, setDuplicateAction] = useState<'skip' | 'update' | 'create' | ''>('')

  // Fetch sorties function
  const fetchSorties = async () => {
    if (!token) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()

      // Apply program filter
      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      // Apply search filter
      if (searchQuery.trim()) {
        params.append('search', searchQuery.trim())
      }

      // Apply date range filters
      if (startDate) {
        params.append('start_date', startDate)
      }
      if (endDate) {
        params.append('end_date', endDate)
      }

      // Apply tail number filter
      if (tailNumberFilter.trim()) {
        params.append('tail_number', tailNumberFilter.trim())
      }

      // Apply effectiveness filter
      if (effectivenessFilter) {
        params.append('sortie_effect', effectivenessFilter)
      }

      const queryString = params.toString()
      const response = await fetch(`/api/sorties${queryString ? '?' + queryString : ''}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data: SortiesResponse = await response.json()
      setSorties(data.sorties)
      setTotal(data.total)
    } catch (err) {
      console.error('Error fetching sorties:', err)
      setError(err instanceof Error ? err.message : 'Failed to load sorties')
    } finally {
      setLoading(false)
    }
  }

  // Fetch pending review sorties
  const fetchPendingReview = async () => {
    if (!token) return
    setPendingLoading(true)
    try {
      const params = new URLSearchParams()
      if (currentProgramId) params.append('program_id', currentProgramId.toString())
      const response = await fetch(`/api/sorties/pending-review?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setPendingSorties(data.sorties || [])
        setPendingTotal(data.total || 0)
      }
    } catch (err) {
      console.error('Error fetching pending review:', err)
    } finally {
      setPendingLoading(false)
    }
  }

  // Validate a sortie
  const handleValidate = async (sortieId: number) => {
    if (!token) return
    setValidating(sortieId)
    try {
      const response = await fetch(`/api/sorties/${sortieId}/validate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
      if (response.ok) {
        fetchPendingReview()
        fetchSorties()
      }
    } catch (err) {
      console.error('Error validating sortie:', err)
    } finally {
      setValidating(null)
    }
  }

  // Adjudicate a sortie
  const handleAdjudicate = async (sortieId: number, status: string) => {
    if (!token) return
    setAdjudicating(sortieId)
    try {
      const response = await fetch(`/api/sorties/${sortieId}/adjudicate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, notes: adjudicationNotes }),
      })
      if (response.ok) {
        setAdjudicationNotes('')
        fetchPendingReview()
        fetchSorties()
      }
    } catch (err) {
      console.error('Error adjudicating sortie:', err)
    } finally {
      setAdjudicating(null)
    }
  }

  // Fetch sorties on mount and when token/program/filters change
  useEffect(() => {
    fetchSorties()
    fetchPendingReview()
  }, [token, currentProgramId, searchQuery, startDate, endDate, tailNumberFilter, effectivenessFilter])

  // Update filtered sorties whenever sorties change
  useEffect(() => {
    setFilteredSorties(sorties)
  }, [sorties])

  // Fetch assets when modal opens
  const fetchAssets = async () => {
    if (!token || !currentProgramId) return

    setAssetsLoading(true)
    try {
      const params = new URLSearchParams()
      params.append('program_id', currentProgramId.toString())

      const response = await fetch(`/api/assets?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setAssets(data.assets || [])
    } catch (err) {
      console.error('Error fetching assets:', err)
      setAssets([])
    } finally {
      setAssetsLoading(false)
    }
  }

  // Open add modal
  const openAddModal = () => {
    setIsAddModalOpen(true)
    setSubmitError(null)
    setSubmitSuccess(null)
    setNewSortieForm({
      asset_id: '',
      mission_id: '',
      sortie_date: new Date().toISOString().split('T')[0], // Default to today
      sortie_effect: '',
      range: '',
      remarks: '',
    })
    fetchAssets()
  }

  // Close add modal
  const closeAddModal = () => {
    if (submitting) return // Prevent closing while submitting
    setIsAddModalOpen(false)
    setSubmitError(null)
    setSubmitSuccess(null)
  }

  // Handle form changes
  const handleFormChange = (field: string, value: string) => {
    setNewSortieForm(prev => ({ ...prev, [field]: value }))
  }

  // Submit new sortie
  const handleSubmitNewSortie = async () => {
    if (!token) return

    // Validation
    if (!newSortieForm.asset_id || !newSortieForm.mission_id || !newSortieForm.sortie_date) {
      setSubmitError('Please fill in all required fields')
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    setSubmitSuccess(null)

    try {
      const response = await fetch('/api/sorties', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(newSortieForm),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setSubmitSuccess('Sortie created successfully!')

      // Refresh the sorties list
      const refreshResponse = await fetch(
        `/api/sorties?program_id=${currentProgramId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json()
        setSorties(refreshData.sorties)
        setTotal(refreshData.total)
      }

      // Close modal after 1.5 seconds
      setTimeout(() => {
        closeAddModal()
      }, 1500)
    } catch (err) {
      console.error('Error creating sortie:', err)
      setSubmitError(err instanceof Error ? err.message : 'Failed to create sortie')
    } finally {
      setSubmitting(false)
    }
  }

  // Open edit modal
  const openEditModal = (sortie: Sortie, e: React.MouseEvent) => {
    e.stopPropagation() // Prevent row click navigation
    setEditingSortie(sortie)
    setEditSortieForm({
      mission_id: sortie.mission_id,
      sortie_date: sortie.sortie_date.split('T')[0], // Format for date input
      sortie_effect: sortie.sortie_effect || '',
      range: sortie.range || '',
      remarks: sortie.remarks || '',
    })
    setIsEditModalOpen(true)
    setSubmitError(null)
    setSubmitSuccess(null)
  }

  // Close edit modal
  const closeEditModal = () => {
    if (submitting) return // Prevent closing while submitting
    setIsEditModalOpen(false)
    setEditingSortie(null)
    setSubmitError(null)
    setSubmitSuccess(null)
  }

  // Handle edit form changes
  const handleEditFormChange = (field: string, value: string) => {
    setEditSortieForm(prev => ({ ...prev, [field]: value }))
  }

  // Submit edit sortie
  const handleSubmitEditSortie = async () => {
    if (!token || !editingSortie) return

    // Validation
    if (!editSortieForm.mission_id || !editSortieForm.sortie_date) {
      setSubmitError('Mission ID and Sortie Date are required')
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    setSubmitSuccess(null)

    try {
      const response = await fetch(`/api/sorties/${editingSortie.sortie_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(editSortieForm),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setSubmitSuccess('Sortie updated successfully!')

      // Refresh the sorties list
      const refreshResponse = await fetch(
        `/api/sorties?program_id=${currentProgramId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json()
        setSorties(refreshData.sorties)
        setTotal(refreshData.total)
      }

      // Close modal after 1.5 seconds
      setTimeout(() => {
        closeEditModal()
      }, 1500)
    } catch (err) {
      console.error('Error updating sortie:', err)
      setSubmitError(err instanceof Error ? err.message : 'Failed to update sortie')
    } finally {
      setSubmitting(false)
    }
  }

  // Open delete confirmation dialog
  const openDeleteDialog = (sortie: Sortie, e: React.MouseEvent) => {
    e.stopPropagation() // Prevent row click navigation
    setSortieToDelete(sortie)
    setIsDeleteDialogOpen(true)
    setDeleteError(null)
  }

  // Close delete confirmation dialog
  const closeDeleteDialog = () => {
    if (deleting) return // Prevent closing while deleting
    setIsDeleteDialogOpen(false)
    setSortieToDelete(null)
    setDeleteError(null)
  }

  // Handle delete sortie
  const handleDeleteSortie = async () => {
    if (!token || !sortieToDelete) return

    setDeleting(true)
    setDeleteError(null)

    try {
      const response = await fetch(`/api/sorties/${sortieToDelete.sortie_id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`)
      }

      // Refresh the sorties list
      const refreshResponse = await fetch(
        `/api/sorties?program_id=${currentProgramId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json()
        setSorties(refreshData.sorties)
        setTotal(refreshData.total)
      }

      // Close dialog
      closeDeleteDialog()
    } catch (err) {
      console.error('Error deleting sortie:', err)
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete sortie')
    } finally {
      setDeleting(false)
    }
  }

  // Format date for display
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  // Download Excel template
  const handleDownloadTemplate = () => {
    const wb = XLSX.utils.book_new()

    // Template header row
    const headerRow = ['Asset Serial Number*', 'Mission ID*', 'Sortie Date (YYYY-MM-DD)*', 'Sortie Effect', 'Range', 'Remarks']

    // Example data rows
    const exampleRows = [
      ['CRIIS-001', 'MISSION-001', '2026-01-20', 'FMC', 'Range A', 'Example sortie'],
      ['CRIIS-002', 'MISSION-002', '2026-01-21', 'PMC', 'Range B', 'Another example'],
    ]

    const allRows = [headerRow, ...exampleRows]
    const ws = XLSX.utils.aoa_to_sheet(allRows)

    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Asset Serial Number
      { wch: 15 },  // Mission ID
      { wch: 25 },  // Sortie Date
      { wch: 25 },  // Sortie Effect
      { wch: 12 },  // Range
      { wch: 40 },  // Remarks
    ]

    XLSX.utils.book_append_sheet(wb, ws, 'Sorties')
    XLSX.writeFile(wb, 'sortie_import_template.xlsx')
  }

  // Handle file selection
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImportFile(file)
    setImportErrors([])
    setImportSuccess(null)

    try {
      const data = await file.arrayBuffer()
      const workbook = XLSX.read(data)
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

      // Skip header row and parse data
      const rows = jsonData.slice(1) as any[]
      const errors: string[] = []
      const preview: any[] = []

      rows.forEach((row, index) => {
        const rowNum = index + 2 // +2 because index starts at 0 and we skipped header

        // Skip empty rows
        if (!row || row.length === 0 || !row[0]) return

        const [serno, mission_id, sortie_date, sortie_effect, range, remarks] = row

        // Validate required fields
        if (!serno) {
          errors.push(`Row ${rowNum}: Asset Serial Number is required`)
        }
        if (!mission_id) {
          errors.push(`Row ${rowNum}: Mission ID is required`)
        }
        if (!sortie_date) {
          errors.push(`Row ${rowNum}: Sortie Date is required`)
        }

        // Validate date format
        if (sortie_date) {
          const dateStr = String(sortie_date)
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/
          if (!dateRegex.test(dateStr)) {
            errors.push(`Row ${rowNum}: Sortie Date must be in YYYY-MM-DD format`)
          }
        }

        preview.push({
          row: rowNum,
          serno: serno || '',
          mission_id: mission_id || '',
          sortie_date: sortie_date || '',
          sortie_effect: sortie_effect || '',
          range: range || '',
          remarks: remarks || '',
        })
      })

      setImportPreview(preview)
      setImportErrors(errors)
    } catch (err) {
      console.error('Error parsing Excel file:', err)
      setImportErrors(['Failed to parse Excel file. Please check the file format.'])
    }
  }

  // Handle import confirmation
  const handleConfirmImport = async () => {
    if (importErrors.length > 0) {
      return // Don't allow import if there are validation errors
    }

    setImporting(true)
    setImportSuccess(null)

    try {
      const response = await fetch('/api/sorties/bulk-import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          sorties: importPreview.map(item => ({
            serno: item.serno,
            mission_id: item.mission_id,
            sortie_date: item.sortie_date,
            sortie_effect: item.sortie_effect || null,
            range: item.range || null,
            remarks: item.remarks || null,
          })),
          duplicateAction: duplicateAction || undefined,
        }),
      })

      const result = await response.json()

      // Handle duplicate detection (409 status)
      if (response.status === 409 && result.duplicates) {
        setImportDuplicates(result.duplicates)
        setImportErrors([]) // Clear any previous errors
        setImporting(false)
        return
      }

      if (!response.ok) {
        // If backend returns an errors array (validation errors), use that
        if (result.errors && Array.isArray(result.errors)) {
          setImportErrors(result.errors)
          setImporting(false)
          return
        }
        // Otherwise throw the generic error
        throw new Error(result.error || 'Failed to import sorties')
      }

      // Success
      let successMessage = `Successfully imported ${result.imported} sortie(s)`
      if (result.updated > 0) {
        successMessage += `, updated ${result.updated}`
      }
      if (result.skipped > 0) {
        successMessage += `, skipped ${result.skipped}`
      }
      setImportSuccess(successMessage)

      // Refresh sorties list
      fetchSorties()

      // Close modal after 2 seconds
      setTimeout(() => {
        setIsImportModalOpen(false)
        setImportFile(null)
        setImportPreview([])
        setImportErrors([])
        setImportSuccess(null)
        setImportDuplicates([])
        setDuplicateAction('')
      }, 2000)
    } catch (err) {
      console.error('Error importing sorties:', err)
      setImportErrors([err instanceof Error ? err.message : 'Failed to import sorties'])
    } finally {
      setImporting(false)
    }
  }

  // Close import modal
  const closeImportModal = () => {
    setIsImportModalOpen(false)
    setImportFile(null)
    setImportPreview([])
    setImportErrors([])
    setImportSuccess(null)
    setImportDuplicates([])
    setDuplicateAction('')
  }

  // Clear all filters
  const clearFilters = () => {
    setSearchQuery('')
    setStartDate('')
    setEndDate('')
    setTailNumberFilter('')
    setEffectivenessFilter('')
  }

  // Check if any filters are active
  const hasActiveFilters = searchQuery || startDate || endDate || tailNumberFilter || effectivenessFilter

  // Get ZULU timestamp for reports
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

  // Export sorties to PDF with CUI markings
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
    doc.text('ACSS Sorties Report', pageWidth / 2, 20, { align: 'center' })

    // Metadata
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${zuluTimestamp}`, 14, 28)
    doc.text(`Total Sorties: ${sorties.length}`, 14, 33)

    // Filters info
    let yPos = 38
    if (hasActiveFilters) {
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      const filters: string[] = []
      if (searchQuery) filters.push(`Search: "${searchQuery}"`)
      if (startDate) filters.push(`From: ${startDate}`)
      if (endDate) filters.push(`To: ${endDate}`)
      if (tailNumberFilter) filters.push(`Tail: "${tailNumberFilter}"`)
      if (effectivenessFilter) filters.push(`Effect: ${effectivenessFilter}`)
      doc.text(`Filters: ${filters.join(', ')}`, 14, yPos)
      yPos += 5
    }

    // Prepare table data
    const tableHeaders = [
      'Mission ID',
      'Serial Number',
      'Tail Number',
      'Sortie Date (ZULU)',
      'Sortie Effect',
      'Range',
      'Current Unit'
    ]

    const tableData = sorties.map(sortie => {
      // Format date in ZULU
      const dateZulu = sortie.sortie_date
        ? new Date(sortie.sortie_date).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z').split(' ')[0] + 'Z'
        : ''

      return [
        sortie.mission_id,
        sortie.serno,
        sortie.ac_tailno || '-',
        dateZulu,
        sortie.sortie_effect || '-',
        sortie.range || '-',
        sortie.current_unit || '-'
      ]
    })

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
    const filename = `CUI-Sorties-${zuluDate}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export sorties to Excel with CUI markings
  const exportToExcel = () => {
    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Use import-compatible format for round-trip export/import
    // This matches the import template format exactly
    const headerRow = ['Asset Serial Number*', 'Mission ID*', 'Sortie Date (YYYY-MM-DD)*', 'Sortie Effect', 'Range', 'Remarks']

    // Data rows - format to match import expectations
    const dataRows = sorties.map(sortie => {
      // Format date as YYYY-MM-DD (compatible with import)
      const dateFormatted = sortie.sortie_date
        ? new Date(sortie.sortie_date).toISOString().split('T')[0]
        : ''

      return [
        sortie.serno,                    // Asset Serial Number
        sortie.mission_id,               // Mission ID
        dateFormatted,                   // Sortie Date (YYYY-MM-DD)
        sortie.sortie_effect || '',      // Sortie Effect
        sortie.range || '',              // Range
        sortie.remarks || ''             // Remarks
      ]
    })

    // Combine header and data rows
    const allRows = [headerRow, ...dataRows]

    // Create worksheet from array of arrays
    const ws = XLSX.utils.aoa_to_sheet(allRows)

    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Asset Serial Number
      { wch: 15 },  // Mission ID
      { wch: 25 },  // Sortie Date
      { wch: 25 },  // Sortie Effect
      { wch: 12 },  // Range
      { wch: 40 },  // Remarks
    ]

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Sorties')

    // Get filename with ZULU date
    const zuluDate = getZuluDateForFilename()
    const filename = `CUI-Sorties-${zuluDate}.xlsx`

    // Write file
    XLSX.writeFile(wb, filename)
  }

  // Loading state
  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={10} columns={9} showHeader={true} />
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-semibold">Error loading sorties</h3>
        <p className="text-red-600 mt-1">{error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sorties</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track sortie missions and aircraft operations
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={exportToPDF}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            disabled={sorties.length === 0}
            title="Export to PDF"
          >
            <DocumentArrowDownIcon className="h-5 w-5 mr-2" />
            Export PDF
          </button>
          <button
            onClick={exportToExcel}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            disabled={sorties.length === 0}
            title="Export to Excel"
          >
            <DocumentArrowDownIcon className="h-5 w-5 mr-2" />
            Export Excel
          </button>
          {user?.role !== 'VIEWER' && (
            <>
              <button
                onClick={() => setIsImportModalOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                <ArrowUpTrayIcon className="h-5 w-5 mr-2" />
                Import
              </button>
              <button
                onClick={openAddModal}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                <PlusIcon className="h-5 w-5 mr-2" />
                Add Sortie
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs: All Sorties / Pending Review */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('all')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'all'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            All Sorties ({total})
          </button>
          <button
            onClick={() => setActiveTab('pending')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'pending'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Pending Review
            {pendingTotal > 0 && (
              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                {pendingTotal}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* Pending Review Tab Content */}
      {activeTab === 'pending' && (
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-yellow-50">
            <h3 className="text-lg font-medium text-gray-900">Post-Import Review & Correction</h3>
            <p className="text-sm text-gray-600 mt-1">
              Review imported sorties for accuracy. Approve, flag for correction, or reject erroneous/duplicate entries.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Serial Number</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sortie Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Effect</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Non-Podded</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Remarks</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {pendingLoading ? (
                  <tr><td colSpan={6} className="px-6 py-12 text-center text-gray-500">Loading...</td></tr>
                ) : pendingSorties.length === 0 ? (
                  <tr><td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                    <CheckCircleIcon className="h-8 w-8 text-green-400 mx-auto mb-2" />
                    All sorties have been reviewed!
                  </td></tr>
                ) : (
                  pendingSorties.map((sortie) => (
                    <tr key={sortie.sortie_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{sortie.serno}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(sortie.sortie_date)}</td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          sortie.sortie_effect === 'PART' ? 'bg-yellow-100 text-yellow-800' :
                          sortie.sortie_effect === 'NEFF' ? 'bg-red-100 text-red-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {sortie.sortie_effect || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {(sortie as any).is_non_podded ? (
                          <span className="text-blue-600 font-medium">Yes</span>
                        ) : 'No'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{sortie.remarks || '-'}</td>
                      <td className="px-4 py-3 text-sm text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleValidate(sortie.sortie_id)}
                            disabled={validating === sortie.sortie_id}
                            className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-green-100 text-green-800 hover:bg-green-200 disabled:opacity-50"
                            title="Approve this sortie"
                          >
                            {validating === sortie.sortie_id ? '...' : '✓ Approve'}
                          </button>
                          <button
                            onClick={() => handleAdjudicate(sortie.sortie_id, 'FLAGGED')}
                            disabled={adjudicating === sortie.sortie_id}
                            className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-yellow-100 text-yellow-800 hover:bg-yellow-200 disabled:opacity-50"
                            title="Flag for correction"
                          >
                            {adjudicating === sortie.sortie_id ? '...' : '⚑ Flag'}
                          </button>
                          <button
                            onClick={() => handleAdjudicate(sortie.sortie_id, 'DUPLICATE')}
                            disabled={adjudicating === sortie.sortie_id}
                            className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-orange-100 text-orange-800 hover:bg-orange-200 disabled:opacity-50"
                            title="Mark as duplicate"
                          >
                            {adjudicating === sortie.sortie_id ? '...' : '⊘ Duplicate'}
                          </button>
                          <button
                            onClick={() => handleAdjudicate(sortie.sortie_id, 'REJECTED')}
                            disabled={adjudicating === sortie.sortie_id}
                            className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50"
                            title="Reject this sortie"
                          >
                            {adjudicating === sortie.sortie_id ? '...' : '✕ Reject'}
                          </button>
                          <button
                            onClick={(e) => openEditModal(sortie, e)}
                            className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800 hover:bg-gray-200"
                            title="Edit sortie details"
                          >
                            ✎ Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-700">
              Showing <span className="font-medium">{pendingSorties.length}</span> of{' '}
              <span className="font-medium">{pendingTotal}</span> pending sorties
            </div>
          </div>
        </div>
      )}

      {/* Search and Filters - only show on All tab */}
      {activeTab === 'all' && <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
        <div className="space-y-4">
          {/* Search bar */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search by mission ID, serial number, or tail number..."
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Filter controls */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Start Date */}
            <div>
              <label htmlFor="start_date" className="block text-sm font-medium text-gray-700 mb-1">
                Start Date
              </label>
              <input
                type="date"
                id="start_date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* End Date */}
            <div>
              <label htmlFor="end_date" className="block text-sm font-medium text-gray-700 mb-1">
                End Date
              </label>
              <input
                type="date"
                id="end_date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* Tail Number Filter */}
            <div>
              <label htmlFor="tail_number" className="block text-sm font-medium text-gray-700 mb-1">
                Tail Number
              </label>
              <input
                type="text"
                id="tail_number"
                value={tailNumberFilter}
                onChange={(e) => setTailNumberFilter(e.target.value)}
                placeholder="Filter by tail number..."
                className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* Effectiveness Filter */}
            <div>
              <label htmlFor="effectiveness_filter" className="block text-sm font-medium text-gray-700 mb-1">
                Effectiveness
              </label>
              <select
                id="effectiveness_filter"
                value={effectivenessFilter}
                onChange={(e) => setEffectivenessFilter(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">All</option>
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

            {/* Clear Filters Button */}
            <div className="flex items-end">
              <button
                onClick={clearFilters}
                disabled={!hasActiveFilters}
                className="w-full px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <XMarkIcon className="h-5 w-5 inline mr-1" />
                Clear Filters
              </button>
            </div>
          </div>

          {/* Active filters indicator */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span className="font-medium">Active filters:</span>
              {searchQuery && (
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800">
                  Search: "{searchQuery}"
                </span>
              )}
              {startDate && (
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800">
                  From: {startDate}
                </span>
              )}
              {endDate && (
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800">
                  To: {endDate}
                </span>
              )}
              {tailNumberFilter && (
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800">
                  Tail: "{tailNumberFilter}"
                </span>
              )}
              {effectivenessFilter && (
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800">
                  Effect: {effectivenessFilter}
                </span>
              )}
            </div>
          )}
        </div>
      </div>}

      {/* Sorties Table - only show on All tab */}
      {activeTab === 'all' && <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Mission ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Serial Number
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tail Number
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Sortie Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Sortie Effect
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Range
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Current Unit
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sorties.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    {searchQuery ? 'No sorties match your search' : 'No sorties found'}
                  </td>
                </tr>
              ) : (
                sorties.map((sortie) => (
                  <tr
                    key={sortie.sortie_id}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => navigate(`/sorties/${sortie.sortie_id}`)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {sortie.mission_id}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {sortie.serno}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {sortie.ac_tailno || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(sortie.sortie_date)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {sortie.sortie_effect ? (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          sortie.sortie_effect.includes('Full')
                            ? 'bg-green-100 text-green-800'
                            : sortie.sortie_effect.includes('Partial')
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {sortie.sortie_effect}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {sortie.range || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {sortie.current_unit || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end gap-3">
                        {user?.role !== 'VIEWER' && (
                          <button
                            onClick={(e) => openEditModal(sortie, e)}
                            className="text-primary-600 hover:text-primary-900 inline-flex items-center"
                            title="Edit sortie"
                          >
                            <PencilIcon className="h-4 w-4 mr-1" />
                            Edit
                          </button>
                        )}
                        {(user?.role === 'ADMIN' || user?.role === 'DEPOT_MANAGER') && (
                          <button
                            onClick={(e) => openDeleteDialog(sortie, e)}
                            className="text-red-600 hover:text-red-900 inline-flex items-center"
                            title="Delete sortie"
                          >
                            <TrashIcon className="h-4 w-4 mr-1" />
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer with count */}
        <div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-700">
              Showing <span className="font-medium">{sorties.length}</span> of{' '}
              <span className="font-medium">{total}</span> sorties
              {searchQuery && (
                <span className="text-gray-500"> (filtered by "{searchQuery}")</span>
              )}
            </div>
          </div>
        </div>
      </div>}

      {/* Add Sortie Modal */}
      <Dialog open={isAddModalOpen} onClose={closeAddModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-xl shadow-xl">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Create New Sortie
              </Dialog.Title>
              <button onClick={closeAddModal} className="text-gray-400 hover:text-gray-500" disabled={submitting} aria-label="Close">
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              {submitSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{submitSuccess}</p>
                  </div>
                </div>
              )}

              {submitError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <ExclamationCircleIcon className="h-5 w-5 text-red-500 mr-2" />
                    <p className="text-red-700 text-sm">{submitError}</p>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="asset_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Asset / Aircraft <span className="text-red-500">*</span>
                </label>
                <select
                  id="asset_id"
                  value={newSortieForm.asset_id}
                  onChange={(e) => handleFormChange('asset_id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={assetsLoading || submitting}
                  required
                >
                  <option value="">Select an asset...</option>
                  {assets.map((asset) => (
                    <option key={asset.asset_id} value={asset.asset_id}>
                      {asset.serno} - {asset.name} ({asset.status_cd})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="mission_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Mission ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="mission_id"
                  value={newSortieForm.mission_id}
                  onChange={(e) => handleFormChange('mission_id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., CRIIS-SORTIE-005"
                  disabled={submitting}
                  required
                />
              </div>

              <div>
                <label htmlFor="sortie_date" className="block text-sm font-medium text-gray-700 mb-1">
                  Sortie Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  id="sortie_date"
                  value={newSortieForm.sortie_date}
                  onChange={(e) => handleFormChange('sortie_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={submitting}
                  required
                />
              </div>

              <div>
                <label htmlFor="sortie_effect" className="block text-sm font-medium text-gray-700 mb-1">
                  Sortie Effectiveness Code
                </label>
                <select
                  id="sortie_effect"
                  value={newSortieForm.sortie_effect}
                  onChange={(e) => handleFormChange('sortie_effect', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={submitting}
                >
                  <option value="">Select effectiveness...</option>
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

              <div>
                <label htmlFor="range" className="block text-sm font-medium text-gray-700 mb-1">
                  Range Code
                </label>
                <input
                  type="text"
                  id="range"
                  value={newSortieForm.range}
                  onChange={(e) => handleFormChange('range', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., R-2508"
                  disabled={submitting}
                />
              </div>

              <div>
                <label htmlFor="remarks" className="block text-sm font-medium text-gray-700 mb-1">
                  Remarks
                </label>
                <textarea
                  id="remarks"
                  value={newSortieForm.remarks}
                  onChange={(e) => handleFormChange('remarks', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter any additional remarks..."
                  rows={3}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
              <button
                onClick={closeAddModal}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitNewSortie}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={submitting || !newSortieForm.asset_id || !newSortieForm.mission_id || !newSortieForm.sortie_date}
              >
                {submitting ? 'Creating...' : 'Create Sortie'}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Edit Sortie Modal */}
      <Dialog open={isEditModalOpen} onClose={closeEditModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-2xl w-full bg-white rounded-lg shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Edit Sortie
              </Dialog.Title>
              <button
                onClick={closeEditModal}
                className="text-gray-400 hover:text-gray-500"
                disabled={submitting}
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            <div className="px-6 py-4 space-y-4">
              {/* Mission ID */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mission ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={editSortieForm.mission_id}
                  onChange={(e) => handleEditFormChange('mission_id', e.target.value)}
                  className="block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., CRIIS-SORTIE-001"
                  disabled={submitting}
                />
              </div>

              {/* Sortie Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sortie Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={editSortieForm.sortie_date}
                  onChange={(e) => handleEditFormChange('sortie_date', e.target.value)}
                  className="block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  disabled={submitting}
                />
              </div>

              {/* Sortie Effect */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sortie Effect
                </label>
                <select
                  value={editSortieForm.sortie_effect}
                  onChange={(e) => handleEditFormChange('sortie_effect', e.target.value)}
                  className="block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  disabled={submitting}
                >
                  <option value="">-- Select Effect --</option>
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

              {/* Range */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Range
                </label>
                <input
                  type="text"
                  value={editSortieForm.range}
                  onChange={(e) => handleEditFormChange('range', e.target.value)}
                  className="block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., Test Range Alpha"
                  disabled={submitting}
                />
              </div>

              {/* Remarks */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Remarks
                </label>
                <textarea
                  value={editSortieForm.remarks}
                  onChange={(e) => handleEditFormChange('remarks', e.target.value)}
                  rows={3}
                  className="block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Additional notes or comments..."
                  disabled={submitting}
                />
              </div>

              {/* Error/Success Messages */}
              {submitError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <ExclamationCircleIcon className="h-5 w-5 text-red-600" />
                  <p className="text-sm text-red-800">{submitError}</p>
                </div>
              )}
              {submitSuccess && (
                <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-md">
                  <CheckCircleIcon className="h-5 w-5 text-green-600" />
                  <p className="text-sm text-green-800">{submitSuccess}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeEditModal}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitEditSortie}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={submitting}
              >
                {submitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onClose={closeDeleteDialog} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-md w-full bg-white rounded-lg shadow-xl">
            <div className="px-6 py-4 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Delete Sortie
              </Dialog.Title>
            </div>

            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-gray-700">
                Are you sure you want to delete this sortie? This action cannot be undone.
              </p>

              {sortieToDelete && (
                <div className="bg-gray-50 border border-gray-200 rounded-md p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm font-medium text-gray-700">Mission ID:</span>
                    <span className="text-sm text-gray-900">{sortieToDelete.mission_id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm font-medium text-gray-700">Serial Number:</span>
                    <span className="text-sm text-gray-900">{sortieToDelete.serno}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm font-medium text-gray-700">Sortie Date:</span>
                    <span className="text-sm text-gray-900">{formatDate(sortieToDelete.sortie_date)}</span>
                  </div>
                  {sortieToDelete.sortie_effect && (
                    <div className="flex justify-between">
                      <span className="text-sm font-medium text-gray-700">Effect:</span>
                      <span className="text-sm text-gray-900">{sortieToDelete.sortie_effect}</span>
                    </div>
                  )}
                </div>
              )}

              {deleteError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <ExclamationCircleIcon className="h-5 w-5 text-red-600" />
                  <p className="text-sm text-red-800">{deleteError}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeDeleteDialog}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteSortie}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete Sortie'}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Import Sorties Modal */}
      <Dialog open={isImportModalOpen} onClose={closeImportModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-4xl w-full bg-white rounded-lg shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Import Sorties from Excel
              </Dialog.Title>
            </div>

            <div className="px-6 py-4 space-y-4">
              {/* Instructions */}
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                <h4 className="text-sm font-medium text-blue-900 mb-2">Import Instructions</h4>
                <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                  <li>Download the Excel template below</li>
                  <li>Fill in your sortie data (required fields marked with *)</li>
                  <li>Upload the completed file</li>
                  <li>Review the preview and fix any validation errors</li>
                  <li>Click "Import Sorties" to complete the import</li>
                </ol>
              </div>

              {/* Download Template Button */}
              <div>
                <button
                  onClick={handleDownloadTemplate}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
                  Download Template
                </button>
              </div>

              {/* File Upload */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Upload Excel File
                </label>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileSelect}
                  className="block w-full text-sm text-gray-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-md file:border-0
                    file:text-sm file:font-semibold
                    file:bg-primary-50 file:text-primary-700
                    hover:file:bg-primary-100
                    cursor-pointer"
                />
                {importFile && (
                  <p className="mt-2 text-sm text-gray-600">
                    Selected: {importFile.name}
                  </p>
                )}
              </div>

              {/* Validation Errors */}
              {importErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4">
                  <div className="flex items-start gap-2">
                    <ExclamationCircleIcon className="h-5 w-5 text-red-600 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-red-900 mb-2">
                        Validation Errors ({importErrors.length})
                      </h4>
                      <ul className="text-sm text-red-800 space-y-1 list-disc list-inside max-h-40 overflow-y-auto">
                        {importErrors.map((error, index) => (
                          <li key={index}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Duplicate Warning and Action Selector */}
              {importDuplicates.length > 0 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
                  <div className="flex items-start gap-2">
                    <ExclamationCircleIcon className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div className="flex-1 space-y-3">
                      <h4 className="text-sm font-medium text-yellow-900">
                        Duplicate Mission IDs Found ({importDuplicates.length})
                      </h4>
                      <p className="text-sm text-yellow-800">
                        The following mission IDs already exist in the system. Please choose how to handle them:
                      </p>

                      {/* Duplicate Details */}
                      <div className="max-h-48 overflow-y-auto">
                        {importDuplicates.map((dup, index) => (
                          <div key={index} className="bg-white rounded-md p-3 mb-2 border border-yellow-300">
                            <div className="font-medium text-sm text-gray-900 mb-2">
                              Row {dup.row}: Mission ID "{dup.mission_id}"
                            </div>
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              <div>
                                <div className="font-medium text-gray-700 mb-1">Existing Record:</div>
                                <div className="text-gray-600 space-y-0.5">
                                  <div>Serial: {dup.existing.serno}</div>
                                  <div>Date: {dup.existing.sortie_date}</div>
                                  <div>Effect: {dup.existing.sortie_effect || 'N/A'}</div>
                                  <div>Range: {dup.existing.range || 'N/A'}</div>
                                </div>
                              </div>
                              <div>
                                <div className="font-medium text-gray-700 mb-1">Import Data:</div>
                                <div className="text-gray-600 space-y-0.5">
                                  <div>Serial: {dup.new.serno}</div>
                                  <div>Date: {dup.new.sortie_date}</div>
                                  <div>Effect: {dup.new.sortie_effect || 'N/A'}</div>
                                  <div>Range: {dup.new.range || 'N/A'}</div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Action Selection */}
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-900">
                          Choose Action for Duplicates:
                        </label>
                        <div className="space-y-2">
                          <label className="flex items-start gap-2 p-2 rounded-md border-2 hover:bg-yellow-50 cursor-pointer"
                            style={{ borderColor: duplicateAction === 'skip' ? '#d97706' : 'transparent' }}>
                            <input
                              type="radio"
                              name="duplicateAction"
                              value="skip"
                              checked={duplicateAction === 'skip'}
                              onChange={(e) => setDuplicateAction(e.target.value as 'skip')}
                              className="mt-0.5"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">Skip Duplicates</div>
                              <div className="text-xs text-gray-600">Ignore duplicate rows and import only new records</div>
                            </div>
                          </label>
                          <label className="flex items-start gap-2 p-2 rounded-md border-2 hover:bg-yellow-50 cursor-pointer"
                            style={{ borderColor: duplicateAction === 'update' ? '#d97706' : 'transparent' }}>
                            <input
                              type="radio"
                              name="duplicateAction"
                              value="update"
                              checked={duplicateAction === 'update'}
                              onChange={(e) => setDuplicateAction(e.target.value as 'update')}
                              className="mt-0.5"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">Update Existing</div>
                              <div className="text-xs text-gray-600">Update existing records with new data from import</div>
                            </div>
                          </label>
                          <label className="flex items-start gap-2 p-2 rounded-md border-2 hover:bg-yellow-50 cursor-pointer"
                            style={{ borderColor: duplicateAction === 'create' ? '#d97706' : 'transparent' }}>
                            <input
                              type="radio"
                              name="duplicateAction"
                              value="create"
                              checked={duplicateAction === 'create'}
                              onChange={(e) => setDuplicateAction(e.target.value as 'create')}
                              className="mt-0.5"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">Create Anyway</div>
                              <div className="text-xs text-gray-600">Create new records even with duplicate mission IDs (not recommended)</div>
                            </div>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Success Message */}
              {importSuccess && (
                <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-md">
                  <CheckCircleIcon className="h-5 w-5 text-green-600" />
                  <p className="text-sm text-green-800">{importSuccess}</p>
                </div>
              )}

              {/* Preview Table */}
              {importPreview.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-2">
                    Preview ({importPreview.length} sortie{importPreview.length !== 1 ? 's' : ''})
                  </h4>
                  <div className="border border-gray-200 rounded-md overflow-hidden">
                    <div className="overflow-x-auto max-h-64">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Row</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Serial Number</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Mission ID</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Sortie Date</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Effect</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Range</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Remarks</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {importPreview.map((item, index) => (
                            <tr key={index} className="hover:bg-gray-50">
                              <td className="px-3 py-2 text-sm text-gray-900">{item.row}</td>
                              <td className="px-3 py-2 text-sm text-gray-900">{item.serno}</td>
                              <td className="px-3 py-2 text-sm text-gray-900">{item.mission_id}</td>
                              <td className="px-3 py-2 text-sm text-gray-900">{item.sortie_date}</td>
                              <td className="px-3 py-2 text-sm text-gray-900">{item.sortie_effect || '-'}</td>
                              <td className="px-3 py-2 text-sm text-gray-900">{item.range || '-'}</td>
                              <td className="px-3 py-2 text-sm text-gray-900 max-w-xs truncate">{item.remarks || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeImportModal}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                disabled={importing}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmImport}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={importing || importPreview.length === 0 || importErrors.length > 0 || (importDuplicates.length > 0 && !duplicateAction)}
              >
                {importing ? 'Importing...' : importDuplicates.length > 0 ? 'Import with Selected Action' : 'Import Sorties'}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  )
}
