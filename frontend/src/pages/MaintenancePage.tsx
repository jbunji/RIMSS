import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tab, Dialog } from '@headlessui/react'
import {
  WrenchScrewdriverIcon,
  MagnifyingGlassIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  ClockIcon,
  CheckCircleIcon,
  PlusIcon,
  XMarkIcon,
  TrashIcon,
  FunnelIcon,
  QueueListIcon,
  Squares2X2Icon,
  CalendarIcon,
  ArrowPathIcon,
  DocumentArrowDownIcon,
  PencilIcon,
} from '@heroicons/react/24/outline'
import { useAuthStore } from '../stores/authStore'
import EmptyMaintenanceIllustration from '../components/EmptyMaintenanceIllustration'
import IconAnimation from '../components/IconAnimation'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'

// Maintenance event interface matching backend
interface MaintenanceEvent {
  event_id: number
  asset_id: number
  asset_sn: string
  asset_name: string
  job_no: string
  discrepancy: string
  start_job: string
  stop_job: string | null
  event_type: 'Standard' | 'PMI' | 'TCTO' | 'BIT/PC'
  priority: 'Routine' | 'Urgent' | 'Critical'
  status: 'open' | 'closed'
  pgm_id: number
  location: string
  pqdr?: boolean // Product Quality Deficiency Report flag
  // Progress tracking fields
  total_repairs?: number
  closed_repairs?: number
  progress_percentage?: number
}

interface Pagination {
  page: number
  limit: number
  total: number
  total_pages: number
}

interface Summary {
  open: number
  closed: number
  critical: number
  urgent: number
  routine: number
  pqdr: number
  total: number
}

interface ProgramInfo {
  pgm_id: number
  pgm_cd: string
  pgm_name: string
}

interface EventsResponse {
  events: MaintenanceEvent[]
  pagination: Pagination
  summary: Summary
  program: ProgramInfo
}

// Asset interface for the dropdown
interface Asset {
  asset_id: number
  serno: string
  name: string
  pgm_id: number
  status_cd: string
  admin_loc: string
}

interface AssetsResponse {
  assets: Asset[]
  pagination: {
    total: number
  }
}

// Sortie interface
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

interface SortiesResponse {
  sorties: Sortie[]
  total: number
}

// Form data for new event
interface NewEventFormData {
  asset_id: string
  discrepancy: string
  event_type: 'Standard' | 'PMI' | 'TCTO' | 'BIT/PC'
  priority: 'Routine' | 'Urgent' | 'Critical'
  start_job: string
  etic: string
  location: string
  sortie_id: string
}

// Priority badge colors
const priorityColors: Record<string, { bg: string; text: string; border: string }> = {
  Critical: { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200' },
  Urgent: { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200' },
  Routine: { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' },
}

// Event type badge colors
const eventTypeColors: Record<string, { bg: string; text: string; border: string }> = {
  Standard: { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-200' },
  PMI: { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200' },
  TCTO: { bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-200' },
  'BIT/PC': { bg: 'bg-cyan-100', text: 'text-cyan-800', border: 'border-cyan-200' },
}

// Status badge colors
const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  open: { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200' },
  closed: { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200' },
}

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ')
}

// Progress bar color based on completion percentage
function getProgressColor(percentage: number): { bg: string; fill: string; text: string } {
  if (percentage >= 76) {
    return { bg: 'bg-green-100', fill: 'bg-green-500', text: 'text-green-700' }
  } else if (percentage >= 26) {
    return { bg: 'bg-amber-100', fill: 'bg-amber-500', text: 'text-amber-700' }
  } else {
    return { bg: 'bg-red-100', fill: 'bg-red-500', text: 'text-red-700' }
  }
}

// Progress bar component
interface ProgressBarProps {
  percentage: number
  totalRepairs: number
  closedRepairs: number
}

function ProgressBar({ percentage, totalRepairs, closedRepairs }: ProgressBarProps) {
  const colors = getProgressColor(percentage)

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500">
          {closedRepairs} of {totalRepairs} {totalRepairs === 1 ? 'repair' : 'repairs'} closed
        </span>
        <span className={`text-xs font-semibold ${colors.text}`}>
          {percentage}%
        </span>
      </div>
      <div className={`w-full h-2 ${colors.bg} rounded-full overflow-hidden`}>
        <div
          className={`h-full ${colors.fill} transition-all duration-300 ease-out`}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  )
}

export default function MaintenancePage() {
  const navigate = useNavigate()
  const { token, currentProgramId, currentLocationId } = useAuthStore()

  // State
  const [events, setEvents] = useState<MaintenanceEvent[]>([])
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, total_pages: 1 })
  const [summary, setSummary] = useState<Summary>({ open: 0, closed: 0, critical: 0, urgent: 0, routine: 0, pqdr: 0, total: 0 })
  const [program, setProgram] = useState<ProgramInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('') // '' = all, or specific type
  const [pqdrFilter, setPqdrFilter] = useState(false) // false = show all, true = only PQDR flagged
  const [dateFromFilter, setDateFromFilter] = useState<string>('') // Date range start (YYYY-MM-DD)
  const [dateToFilter, setDateToFilter] = useState<string>('') // Date range end (YYYY-MM-DD)
  const [activeTab, setActiveTab] = useState(0) // 0 = Backlog (open), 1 = History (closed), 2 = PMI, 3 = TCTO

  // PMI Tab State
  interface PMIRecord {
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
    interval_days: number // PMI interval in days (30, 60, 90, 180, 365)
  }

  interface PMISummary {
    overdue: number
    red: number
    yellow: number
    green: number
    total: number
  }

  const [pmiRecords, setPmiRecords] = useState<PMIRecord[]>([])
  const [pmiSummary, setPmiSummary] = useState<PMISummary>({ overdue: 0, red: 0, yellow: 0, green: 0, total: 0 })
  const [pmiLoading, setPmiLoading] = useState(false)
  const [pmiError, setPmiError] = useState<string | null>(null)
  const [pmiIntervalFilter, setPmiIntervalFilter] = useState<string>('') // Interval filter: '', '30', '60', '90', '180', '365'
  const [pmiSearchQuery, setPmiSearchQuery] = useState<string>('') // Search by asset serial number
  const [debouncedPmiSearch, setDebouncedPmiSearch] = useState<string>('') // Debounced search value
  const [pmiOverdueOnly, setPmiOverdueOnly] = useState<boolean>(false) // Filter to show only overdue PMIs

  // TCTO Tab State
  interface TCTORecord {
    tcto_id: number
    tcto_no: string
    title: string
    effective_date: string
    compliance_deadline: string
    pgm_id: number
    status: 'open' | 'closed'
    priority: 'Routine' | 'Urgent' | 'Critical'
    affected_assets: number[]
    compliant_assets: number[]
    description: string
    created_by_id: number
    created_by_name: string
    created_at: string
    // Calculated fields from API
    days_until_deadline: number
    compliance_percentage: number
    assets_remaining: number
    is_overdue: boolean
    program_code: string
    program_name: string
  }

  interface TCTOSummary {
    total: number
    open: number
    closed: number
    overdue: number
    critical: number
    urgent: number
    routine: number
  }

  const [tctoRecords, setTctoRecords] = useState<TCTORecord[]>([])
  const [tctoSummary, setTctoSummary] = useState<TCTOSummary>({ total: 0, open: 0, closed: 0, overdue: 0, critical: 0, urgent: 0, routine: 0 })
  const [tctoLoading, setTctoLoading] = useState(false)
  const [tctoError, setTctoError] = useState<string | null>(null)

  // TCTO Search and Filter State
  const [tctoSearch, setTctoSearch] = useState('')
  const [debouncedTctoSearch, setDebouncedTctoSearch] = useState('')
  const [tctoPriorityFilter, setTctoPriorityFilter] = useState<'Critical' | 'Urgent' | 'Routine' | ''>('')
  const [tctoStatusFilter, setTctoStatusFilter] = useState<'open' | 'closed' | ''>('')

  // Edit TCTO Modal State
  interface EditTCTOFormData {
    effective_date: string
    compliance_deadline: string
    priority: 'Routine' | 'Urgent' | 'Critical'
    status: 'open' | 'closed'
    description: string
  }

  const [isEditTCTOModalOpen, setIsEditTCTOModalOpen] = useState(false)
  const [tctoToEdit, setTctoToEdit] = useState<TCTORecord | null>(null)
  const [editTCTOLoading, setEditTCTOLoading] = useState(false)
  const [editTCTOError, setEditTCTOError] = useState<string | null>(null)
  const [editTCTOSuccess, setEditTCTOSuccess] = useState<string | null>(null)
  const [editTCTOForm, setEditTCTOForm] = useState<EditTCTOFormData>({
    effective_date: '',
    compliance_deadline: '',
    priority: 'Routine',
    status: 'open',
    description: '',
  })

  // Delete TCTO Modal State
  const [isDeleteTCTOModalOpen, setIsDeleteTCTOModalOpen] = useState(false)
  const [tctoToDelete, setTctoToDelete] = useState<TCTORecord | null>(null)
  const [deleteTCTOLoading, setDeleteTCTOLoading] = useState(false)
  const [deleteTCTOError, setDeleteTCTOError] = useState<string | null>(null)
  const [deleteTCTOSuccess, setDeleteTCTOSuccess] = useState<string | null>(null)

  // View mode for Backlog tab: 'list' or 'grouped'
  const [viewMode, setViewMode] = useState<'list' | 'grouped'>('list')
  // Expanded configuration groups in grouped view (key = asset_name)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // New Event Modal State
  const [isNewEventModalOpen, setIsNewEventModalOpen] = useState(false)
  const [assets, setAssets] = useState<Asset[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [sorties, setSorties] = useState<Sortie[]>([])
  const [sortiesLoading, setSortiesLoading] = useState(false)
  const [newEventLoading, setNewEventLoading] = useState(false)
  const [newEventError, setNewEventError] = useState<string | null>(null)
  const [newEventSuccess, setNewEventSuccess] = useState<string | null>(null)
  const [newEventFieldErrors, setNewEventFieldErrors] = useState<{ [key: string]: string }>({})
  const [newEventForm, setNewEventForm] = useState<NewEventFormData>({
    asset_id: '',
    discrepancy: '',
    event_type: 'Standard',
    priority: 'Routine',
    start_job: new Date().toISOString().split('T')[0],
    etic: '',
    location: '',
    sortie_id: '',
  })

  // Delete Event Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [eventToDelete, setEventToDelete] = useState<MaintenanceEvent | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null)

  // New PMI Modal State
  interface NewPMIFormData {
    asset_id: string
    pmi_type: string
    next_due_date: string
    wuc_cd: string
    interval_days: string
  }

  const [isNewPMIModalOpen, setIsNewPMIModalOpen] = useState(false)
  const [newPMILoading, setNewPMILoading] = useState(false)
  const [newPMIError, setNewPMIError] = useState<string | null>(null)
  const [newPMISuccess, setNewPMISuccess] = useState<string | null>(null)
  const [newPMIForm, setNewPMIForm] = useState<NewPMIFormData>({
    asset_id: '',
    pmi_type: '',
    next_due_date: '',
    wuc_cd: '',
    interval_days: '',
  })

  // Get user info from token to check role
  const { user } = useAuthStore()
  const canCreateEvent = user && ['ADMIN', 'DEPOT_MANAGER', 'FIELD_TECHNICIAN'].includes(user.role)
  const canDeleteEvent = user && user.role === 'ADMIN'
  const canCreatePMI = user && ['ADMIN', 'DEPOT_MANAGER'].includes(user.role)
  const canCreateTCTO = user && ['ADMIN', 'DEPOT_MANAGER'].includes(user.role)

  // New TCTO Modal State
  interface NewTCTOFormData {
    tcto_no: string
    title: string
    tcto_type: string
    sys_type: string
    effective_date: string
    compliance_deadline: string
    priority: 'Routine' | 'Urgent' | 'Critical'
    description: string
    remarks: string
  }

  const [isNewTCTOModalOpen, setIsNewTCTOModalOpen] = useState(false)
  const [newTCTOLoading, setNewTCTOLoading] = useState(false)
  const [newTCTOError, setNewTCTOError] = useState<string | null>(null)
  const [newTCTOSuccess, setNewTCTOSuccess] = useState<string | null>(null)
  const [newTCTOForm, setNewTCTOForm] = useState<NewTCTOFormData>({
    tcto_no: '',
    title: '',
    tcto_type: '',
    sys_type: '',
    effective_date: new Date().toISOString().split('T')[0],
    compliance_deadline: '',
    priority: 'Routine',
    description: '',
    remarks: '',
  })

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 150)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Debounce PMI search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedPmiSearch(pmiSearchQuery)
    }, 150)
    return () => clearTimeout(timer)
  }, [pmiSearchQuery])

  // Debounce TCTO search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTctoSearch(tctoSearch)
    }, 150)
    return () => clearTimeout(timer)
  }, [tctoSearch])

  // Fetch events
  const fetchEvents = useCallback(async (page: number = 1, status?: 'open' | 'closed') => {
    if (!token) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '10',
      })

      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      if (currentLocationId && currentLocationId !== 0) {
        params.append('location_id', currentLocationId.toString())
      }

      if (status) {
        params.append('status', status)
      }

      if (debouncedSearch) {
        params.append('search', debouncedSearch)
      }

      if (eventTypeFilter) {
        params.append('event_type', eventTypeFilter)
      }

      if (pqdrFilter) {
        params.append('pqdr', 'true')
      }

      if (dateFromFilter) {
        params.append('date_from', dateFromFilter)
      }

      if (dateToFilter) {
        params.append('date_to', dateToFilter)
      }

      const response = await fetch(`/api/events?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch maintenance events')
      }

      const data: EventsResponse = await response.json()
      setEvents(data.events)
      setPagination(data.pagination)
      setSummary(data.summary)
      setProgram(data.program)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [token, currentProgramId, currentLocationId, debouncedSearch, eventTypeFilter, pqdrFilter, dateFromFilter, dateToFilter])

  // Fetch events when tab changes, search changes, or event type filter changes
  useEffect(() => {
    const status = activeTab === 0 ? 'open' : 'closed'
    fetchEvents(1, status)
  }, [fetchEvents, activeTab, debouncedSearch, eventTypeFilter, pqdrFilter, dateFromFilter, dateToFilter])

  // Refetch when program changes
  useEffect(() => {
    const status = activeTab === 0 ? 'open' : 'closed'
    fetchEvents(1, status)
  }, [currentProgramId])

  // Handle page change
  const handlePageChange = (newPage: number) => {
    const status = activeTab === 0 ? 'open' : 'closed'
    fetchEvents(newPage, status)
  }

  // Handle event click
  const handleEventClick = (eventId: number) => {
    navigate(`/maintenance/${eventId}`)
  }

  // Fetch assets for the dropdown
  const fetchAssets = useCallback(async () => {
    if (!token) return

    setAssetsLoading(true)
    try {
      const params = new URLSearchParams({
        limit: '100', // Get all assets for the dropdown
      })

      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      const response = await fetch(`/api/assets?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch assets')
      }

      const data: AssetsResponse = await response.json()
      setAssets(data.assets)
    } catch (err) {
      console.error('Error fetching assets:', err)
    } finally {
      setAssetsLoading(false)
    }
  }, [token, currentProgramId])

  // Fetch sorties for the dropdown
  const fetchSorties = useCallback(async () => {
    if (!token) return

    setSortiesLoading(true)
    try {
      const params = new URLSearchParams()

      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      const response = await fetch(`/api/sorties?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch sorties')
      }

      const data: SortiesResponse = await response.json()
      setSorties(data.sorties)
    } catch (err) {
      console.error('Error fetching sorties:', err)
    } finally {
      setSortiesLoading(false)
    }
  }, [token, currentProgramId])

  // Fetch PMI records
  const fetchPMI = useCallback(async () => {
    if (!token) return

    setPmiLoading(true)
    setPmiError(null)
    try {
      const params = new URLSearchParams()

      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      if (currentLocationId && currentLocationId !== 0) {
        params.append('location_id', currentLocationId.toString())
      }

      // Add interval filter if specified
      if (pmiIntervalFilter) {
        params.append('interval_days', pmiIntervalFilter)
      }

      // Add search filter if specified
      if (debouncedPmiSearch) {
        params.append('search', debouncedPmiSearch)
      }

      // Add overdue only filter if enabled
      if (pmiOverdueOnly) {
        params.append('overdue_only', 'true')
      }

      const response = await fetch(`/api/pmi/due-soon?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch PMI records')
      }

      const data = await response.json()
      setPmiRecords(data.pmi)
      setPmiSummary(data.summary)
    } catch (err) {
      setPmiError(err instanceof Error ? err.message : 'An error occurred')
      console.error('Error fetching PMI:', err)
    } finally {
      setPmiLoading(false)
    }
  }, [token, currentProgramId, currentLocationId, pmiIntervalFilter, debouncedPmiSearch, pmiOverdueOnly])

  // Fetch PMI when tab changes to PMI or when program/interval/search/overdue filter changes
  useEffect(() => {
    if (activeTab === 2) {
      fetchPMI()
    }
  }, [activeTab, fetchPMI, currentProgramId, pmiIntervalFilter, debouncedPmiSearch, pmiOverdueOnly])

  // Fetch TCTO records
  const fetchTCTO = useCallback(async () => {
    if (!token) return

    setTctoLoading(true)
    setTctoError(null)
    try {
      const params = new URLSearchParams()

      if (currentProgramId) {
        params.append('program_id', currentProgramId.toString())
      }

      if (currentLocationId && currentLocationId !== 0) {
        params.append('location_id', currentLocationId.toString())
      }

      // Add search parameter
      if (debouncedTctoSearch) {
        params.append('search', debouncedTctoSearch)
      }

      // Add status filter parameter
      if (tctoStatusFilter) {
        params.append('status', tctoStatusFilter)
      }

      const response = await fetch(`/api/tcto?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to fetch TCTO records')
      }

      const data = await response.json()

      // Apply client-side priority filter (since backend doesn't support it yet)
      let filteredRecords = data.tcto
      if (tctoPriorityFilter) {
        filteredRecords = filteredRecords.filter((tcto: TCTORecord) => tcto.priority === tctoPriorityFilter)
      }

      setTctoRecords(filteredRecords)
      setTctoSummary(data.summary)
    } catch (err) {
      setTctoError(err instanceof Error ? err.message : 'An error occurred')
      console.error('Error fetching TCTO:', err)
    } finally {
      setTctoLoading(false)
    }
  }, [token, currentProgramId, debouncedTctoSearch, tctoStatusFilter, tctoPriorityFilter])

  // Fetch TCTO when tab changes to TCTO or when program changes
  useEffect(() => {
    if (activeTab === 3) {
      fetchTCTO()
    }
  }, [activeTab, fetchTCTO, currentProgramId, currentLocationId])

  // Open Edit TCTO modal
  const openEditTCTOModal = (tcto: TCTORecord, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
    }
    setTctoToEdit(tcto)
    setEditTCTOForm({
      effective_date: tcto.effective_date,
      compliance_deadline: tcto.compliance_deadline,
      priority: tcto.priority,
      status: tcto.status,
      description: tcto.description,
    })
    setEditTCTOError(null)
    setEditTCTOSuccess(null)
    setIsEditTCTOModalOpen(true)
  }

  // Close Edit TCTO modal
  const closeEditTCTOModal = () => {
    setIsEditTCTOModalOpen(false)
    setTctoToEdit(null)
    setEditTCTOError(null)
    setEditTCTOSuccess(null)
  }

  // Submit Edit TCTO form
  const handleEditTCTOSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!tctoToEdit || !token) return

    setEditTCTOLoading(true)
    setEditTCTOError(null)
    setEditTCTOSuccess(null)

    try {
      const response = await fetch(`/api/tcto/${tctoToEdit.tcto_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          effective_date: editTCTOForm.effective_date,
          compliance_deadline: editTCTOForm.compliance_deadline,
          priority: editTCTOForm.priority,
          status: editTCTOForm.status,
          description: editTCTOForm.description,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to update TCTO')
      }

      const data = await response.json()
      setEditTCTOSuccess(`TCTO ${data.tcto.tcto_no} updated successfully`)

      // Refresh TCTO list
      await fetchTCTO()

      // Close modal after brief delay to show success message
      setTimeout(() => {
        closeEditTCTOModal()
      }, 1500)
    } catch (err) {
      setEditTCTOError(err instanceof Error ? err.message : 'An error occurred')
      console.error('Error updating TCTO:', err)
    } finally {
      setEditTCTOLoading(false)
    }
  }

  // Check if user can edit TCTO (depot_manager or admin)
  const canEditTCTO = user?.role === 'DEPOT_MANAGER' || user?.role === 'ADMIN'

  // Check if user can delete TCTO (admin only)
  const canDeleteTCTO = user?.role === 'ADMIN'

  // Open delete TCTO confirmation modal
  const openDeleteTCTOModal = (tcto: TCTORecord, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
    }
    setTctoToDelete(tcto)
    setDeleteTCTOError(null)
    setDeleteTCTOSuccess(null)
    setIsDeleteTCTOModalOpen(true)
  }

  // Close delete TCTO modal
  const closeDeleteTCTOModal = () => {
    setIsDeleteTCTOModalOpen(false)
    setTctoToDelete(null)
    setDeleteTCTOError(null)
    setDeleteTCTOSuccess(null)
  }

  // Handle delete TCTO
  const handleDeleteTCTO = async () => {
    if (!token || !tctoToDelete) return

    setDeleteTCTOLoading(true)
    setDeleteTCTOError(null)

    try {
      const response = await fetch(`/api/tcto/${tctoToDelete.tcto_id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete TCTO')
      }

      const data = await response.json()
      setDeleteTCTOSuccess(`TCTO "${data.tcto.tcto_no}" deleted successfully!`)

      // Refresh the TCTO list after a short delay to show success message
      setTimeout(() => {
        closeDeleteTCTOModal()
        fetchTCTO()
      }, 1500)
    } catch (err) {
      setDeleteTCTOError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setDeleteTCTOLoading(false)
    }
  }

  // Format TCTO priority colors
  const getTCTOPriorityStyle = (priority: string) => {
    switch (priority) {
      case 'Critical':
        return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200' }
      case 'Urgent':
        return { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200' }
      default:
        return { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' }
    }
  }

  // Format TCTO status colors
  const getTCTOStatusStyle = (status: string, isOverdue: boolean) => {
    if (status === 'closed') {
      return { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-200', label: 'CLOSED' }
    }
    if (isOverdue) {
      return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', label: 'OVERDUE' }
    }
    return { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', label: 'OPEN' }
  }

  // Open new event modal
  const openNewEventModal = () => {
    setNewEventForm({
      asset_id: '',
      discrepancy: '',
      event_type: 'Standard',
      priority: 'Routine',
      start_job: new Date().toISOString().split('T')[0],
      etic: '',
      location: '',
      sortie_id: '',
    })
    setNewEventError(null)
    setNewEventSuccess(null)
    fetchAssets()
    fetchSorties()
    setIsNewEventModalOpen(true)
  }

  // Close new event modal
  const closeNewEventModal = () => {
    setIsNewEventModalOpen(false)
    setNewEventError(null)
    setNewEventSuccess(null)
    setNewEventFieldErrors({})
  }

  // Open new PMI modal
  const openNewPMIModal = () => {
    setNewPMIForm({
      asset_id: '',
      pmi_type: '',
      next_due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Default to 30 days from now
      wuc_cd: '',
      interval_days: '30',
    })
    setNewPMIError(null)
    setNewPMISuccess(null)
    fetchAssets()
    setIsNewPMIModalOpen(true)
  }

  // Close new PMI modal
  const closeNewPMIModal = () => {
    setIsNewPMIModalOpen(false)
    setNewPMIError(null)
    setNewPMISuccess(null)
  }

  // Handle PMI form input changes
  const handlePMIFormChange = (field: keyof typeof newPMIForm, value: string) => {
    setNewPMIForm(prev => ({ ...prev, [field]: value }))
    setNewPMIError(null)
  }

  // Handle PMI creation
  const handleCreatePMI = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validate required fields
    if (!newPMIForm.asset_id) {
      setNewPMIError('Please select an asset')
      return
    }
    if (!newPMIForm.pmi_type.trim()) {
      setNewPMIError('Please enter a PMI type')
      return
    }
    if (!newPMIForm.next_due_date) {
      setNewPMIError('Please select a due date')
      return
    }

    setNewPMILoading(true)
    setNewPMIError(null)

    try {
      const response = await fetch('/api/pmi', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          asset_id: parseInt(newPMIForm.asset_id, 10),
          pmi_type: newPMIForm.pmi_type.trim(),
          next_due_date: newPMIForm.next_due_date,
          wuc_cd: newPMIForm.wuc_cd.trim() || undefined,
          interval_days: newPMIForm.interval_days ? parseInt(newPMIForm.interval_days, 10) : undefined,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create PMI record')
      }

      const data = await response.json()
      setNewPMISuccess(`PMI record "${data.pmi.pmi_type}" created successfully for asset ${data.pmi.asset_sn}`)

      // Refresh PMI data after successful creation
      fetchPMI()

      // Close modal after a short delay
      setTimeout(() => {
        closeNewPMIModal()
      }, 1500)
    } catch (err) {
      setNewPMIError(err instanceof Error ? err.message : 'Failed to create PMI record')
    } finally {
      setNewPMILoading(false)
    }
  }

  // Open new TCTO modal
  const openNewTCTOModal = () => {
    setNewTCTOForm({
      tcto_no: '',
      title: '',
      tcto_type: '',
      sys_type: '',
      effective_date: new Date().toISOString().split('T')[0],
      compliance_deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      priority: 'Routine',
      description: '',
      remarks: '',
    })
    setNewTCTOError(null)
    setNewTCTOSuccess(null)
    setIsNewTCTOModalOpen(true)
  }

  // Close new TCTO modal
  const closeNewTCTOModal = () => {
    setIsNewTCTOModalOpen(false)
    setNewTCTOError(null)
    setNewTCTOSuccess(null)
  }

  // Handle TCTO form input changes
  const handleTCTOFormChange = (field: keyof NewTCTOFormData, value: string) => {
    setNewTCTOForm(prev => ({ ...prev, [field]: value }))
    setNewTCTOError(null)
  }

  // Handle TCTO creation
  const handleCreateTCTO = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validate required fields
    if (!newTCTOForm.tcto_no.trim()) {
      setNewTCTOError('Please enter a TCTO number')
      return
    }
    if (!newTCTOForm.title.trim()) {
      setNewTCTOError('Please enter a TCTO title')
      return
    }
    if (!newTCTOForm.effective_date) {
      setNewTCTOError('Please select an effective date')
      return
    }
    if (!newTCTOForm.compliance_deadline) {
      setNewTCTOError('Please select a compliance deadline')
      return
    }

    setNewTCTOLoading(true)
    setNewTCTOError(null)

    try {
      const response = await fetch('/api/tcto', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          tcto_no: newTCTOForm.tcto_no.trim(),
          title: newTCTOForm.title.trim(),
          tcto_type: newTCTOForm.tcto_type.trim() || undefined,
          sys_type: newTCTOForm.sys_type.trim() || undefined,
          effective_date: newTCTOForm.effective_date,
          compliance_deadline: newTCTOForm.compliance_deadline,
          priority: newTCTOForm.priority,
          description: newTCTOForm.description.trim() || undefined,
          remarks: newTCTOForm.remarks.trim() || undefined,
          pgm_id: currentProgramId,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create TCTO record')
      }

      const data = await response.json()
      setNewTCTOSuccess(`TCTO "${data.tcto_no}" created successfully`)

      // Refresh TCTO data after successful creation
      fetchTCTO()

      // Close modal after a short delay
      setTimeout(() => {
        closeNewTCTOModal()
      }, 1500)
    } catch (err) {
      setNewTCTOError(err instanceof Error ? err.message : 'Failed to create TCTO record')
    } finally {
      setNewTCTOLoading(false)
    }
  }

  // Handle form input changes
  const handleFormChange = (field: keyof NewEventFormData, value: string) => {
    setNewEventForm(prev => ({ ...prev, [field]: value }))
    setNewEventError(null)
  }

  // Update location when asset changes
  useEffect(() => {
    if (newEventForm.asset_id) {
      const selectedAsset = assets.find(a => a.asset_id.toString() === newEventForm.asset_id)
      if (selectedAsset) {
        setNewEventForm(prev => ({ ...prev, location: selectedAsset.admin_loc || '' }))
      }
    }
  }, [newEventForm.asset_id, assets])

  // Submit new event
  const handleSubmitNewEvent = async () => {
    if (!token) return

    // Validate form - collect all errors
    const fieldErrors: { [key: string]: string } = {}

    if (!newEventForm.asset_id) {
      fieldErrors.asset_id = 'Please select an asset'
    }
    if (!newEventForm.discrepancy.trim()) {
      fieldErrors.discrepancy = 'Please enter a discrepancy description'
    } else if (newEventForm.discrepancy.trim().length < 10) {
      fieldErrors.discrepancy = 'Discrepancy description must be at least 10 characters'
    } else if (newEventForm.discrepancy.trim().length > 500) {
      fieldErrors.discrepancy = 'Discrepancy description must not exceed 500 characters'
    }
    if (!newEventForm.start_job) {
      fieldErrors.start_job = 'Please select a date in'
    }

    // If there are any errors, set them and return
    if (Object.keys(fieldErrors).length > 0) {
      setNewEventFieldErrors(fieldErrors)
      return
    }

    setNewEventLoading(true)
    setNewEventError(null)
    setNewEventFieldErrors({})

    try {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          asset_id: parseInt(newEventForm.asset_id, 10),
          discrepancy: newEventForm.discrepancy.trim(),
          event_type: newEventForm.event_type,
          priority: newEventForm.priority,
          start_job: newEventForm.start_job,
          etic: newEventForm.etic || null,
          location: newEventForm.location || null,
          sortie_id: newEventForm.sortie_id || null,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create maintenance event')
      }

      const data = await response.json()
      setNewEventSuccess(`Maintenance event ${data.event.job_no} created successfully!`)

      // Refresh the events list after a short delay to show success message
      setTimeout(() => {
        closeNewEventModal()
        const status = activeTab === 0 ? 'open' : 'closed'
        fetchEvents(1, status)
      }, 1500)
    } catch (err) {
      setNewEventError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setNewEventLoading(false)
    }
  }

  // Open delete confirmation modal
  const openDeleteModal = (event: MaintenanceEvent, e: React.MouseEvent) => {
    e.stopPropagation() // Prevent row click navigation
    setEventToDelete(event)
    setDeleteError(null)
    setDeleteSuccess(null)
    setIsDeleteModalOpen(true)
  }

  // Close delete modal
  const closeDeleteModal = () => {
    setIsDeleteModalOpen(false)
    setEventToDelete(null)
    setDeleteError(null)
    setDeleteSuccess(null)
  }

  // Handle delete event
  const handleDeleteEvent = async () => {
    if (!token || !eventToDelete) return

    setDeleteLoading(true)
    setDeleteError(null)

    try {
      const response = await fetch(`/api/events/${eventToDelete.event_id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete maintenance event')
      }

      const data = await response.json()
      const repairsMsg = data.repairs_deleted > 0 ? ` (${data.repairs_deleted} repair(s) also removed)` : ''
      setDeleteSuccess(`Maintenance event "${data.event.job_no}" deleted successfully!${repairsMsg}`)

      // Refresh the events list after a short delay to show success message
      setTimeout(() => {
        closeDeleteModal()
        const status = activeTab === 0 ? 'open' : 'closed'
        fetchEvents(1, status)
      }, 1500)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setDeleteLoading(false)
    }
  }

  // Format date (timezone-safe for date-only strings)
  const formatDate = (dateString: string) => {
    // For date-only strings (YYYY-MM-DD), parse as local timezone to avoid off-by-one errors
    if (dateString && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-').map(Number)
      const date = new Date(year, month - 1, day)
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }
    // For datetime strings, use normal Date parsing
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // Calculate days open
  const calculateDaysOpen = (startJob: string, stopJob: string | null) => {
    const start = new Date(startJob)
    const end = stopJob ? new Date(stopJob) : new Date()
    const diffTime = Math.abs(end.getTime() - start.getTime())
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    return diffDays
  }

  // Group events by configuration (asset_name)
  const groupEventsByConfiguration = (eventsToGroup: MaintenanceEvent[]) => {
    const grouped: Map<string, MaintenanceEvent[]> = new Map()
    eventsToGroup.forEach(event => {
      const key = event.asset_name
      const existing = grouped.get(key) || []
      grouped.set(key, [...existing, event])
    })
    // Sort groups by total number of events (descending), then alphabetically
    return Array.from(grouped.entries()).sort((a, b) => {
      if (b[1].length !== a[1].length) {
        return b[1].length - a[1].length
      }
      return a[0].localeCompare(b[0])
    })
  }

  // Toggle expanded state for a configuration group
  const toggleGroup = (configName: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev)
      if (newSet.has(configName)) {
        newSet.delete(configName)
      } else {
        newSet.add(configName)
      }
      return newSet
    })
  }

  // Expand all groups
  const expandAllGroups = () => {
    const allGroups = new Set(events.map(e => e.asset_name))
    setExpandedGroups(allGroups)
  }

  // Collapse all groups
  const collapseAllGroups = () => {
    setExpandedGroups(new Set())
  }

  // Format date for display
  const formatDateForExport = (dateString: string | null) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // Get ZULU timestamp for display
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

  // Export maintenance events to PDF with CUI markings
  const exportToPdf = () => {
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
      doc.text('ACSS Maintenance Events Report', pageWidth / 2, 20, { align: 'center' })

      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(55, 65, 81) // Gray
      const programText = program ? `Program: ${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'
      doc.text(programText, pageWidth / 2, 27, { align: 'center' })

      doc.setFontSize(9)
      doc.text(`Report generated: ${zuluTimestamp}`, pageWidth / 2, 33, { align: 'center' })

      // Status info
      const statusText = activeTab === 0 ? 'Status: Open Events (Backlog)' : 'Status: Closed Events (History)'
      doc.text(statusText, pageWidth / 2, 38, { align: 'center' })
      doc.text(`Total Events: ${pagination.total}`, pageWidth / 2, 43, { align: 'center' })

      // Add filter info if applied
      const filters: string[] = []
      if (eventTypeFilter) filters.push(`Event Type: ${eventTypeFilter}`)
      if (debouncedSearch) filters.push(`Search: "${debouncedSearch}"`)
      if (pqdrFilter) filters.push('PQDR Only')
      if (dateFromFilter) filters.push(`From: ${dateFromFilter}`)
      if (dateToFilter) filters.push(`To: ${dateToFilter}`)

      if (filters.length > 0) {
        doc.setFontSize(8)
        doc.setTextColor(107, 114, 128)
        doc.text(`Filters: ${filters.join(', ')}`, pageWidth / 2, 48, { align: 'center' })
      }
    }

    // Prepare table data
    const tableData = events.map(event => {
      const daysOpen = calculateDaysOpen(event.start_job, event.stop_job)
      const progressText = event.total_repairs !== undefined && event.total_repairs > 0
        ? `${event.progress_percentage}% (${event.closed_repairs}/${event.total_repairs})`
        : 'No repairs'
      return [
        event.job_no + (event.pqdr ? ' (PQDR)' : ''),
        event.asset_sn,
        event.asset_name,
        event.discrepancy.length > 50 ? event.discrepancy.substring(0, 47) + '...' : event.discrepancy,
        event.event_type,
        event.priority,
        event.location,
        formatDateForExport(event.start_job),
        `${daysOpen} day${daysOpen !== 1 ? 's' : ''}`,
        progressText,
        event.status.toUpperCase()
      ]
    })

    // Add header to first page
    addCuiHeader()
    addTitle()

    // Calculate start Y position based on filters
    const filters: string[] = []
    if (eventTypeFilter) filters.push(`Event Type: ${eventTypeFilter}`)
    if (debouncedSearch) filters.push(`Search: "${debouncedSearch}"`)
    if (pqdrFilter) filters.push('PQDR Only')
    if (dateFromFilter) filters.push(`From: ${dateFromFilter}`)
    if (dateToFilter) filters.push(`To: ${dateToFilter}`)
    const startY = filters.length > 0 ? 53 : 48

    // Generate table with autoTable
    autoTable(doc, {
      startY: startY,
      head: [['Job #', 'Serial #', 'Asset Name', 'Discrepancy', 'Type', 'Priority', 'Base Location', 'Date In', 'Duration', 'Progress', 'Status']],
      body: tableData,
      theme: 'striped',
      headStyles: {
        fillColor: [30, 64, 175], // Primary blue
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 8
      },
      bodyStyles: {
        fontSize: 7,
        textColor: [55, 65, 81]
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] // Light gray
      },
      margin: { top: 15, bottom: 15, left: 5, right: 5 },
      didDrawPage: () => {
        // Add CUI header on each page
        addCuiHeader()
      },
      // Style specific columns
      columnStyles: {
        0: { cellWidth: 25 },  // Job #
        1: { cellWidth: 25 },  // Serial #
        2: { cellWidth: 35 },  // Asset Name
        3: { cellWidth: 55 },  // Discrepancy
        4: { cellWidth: 20 },  // Type
        5: { cellWidth: 20 },  // Priority
        6: { cellWidth: 30 },  // Location
        7: { cellWidth: 25 },  // Date In
        8: { cellWidth: 22 },  // Duration
        9: { cellWidth: 20 },  // Status
      }
    })

    // Get total pages and add footers
    const totalPages = doc.getNumberOfPages()
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i)
      addCuiFooter(i, totalPages)
    }

    // Generate filename with CUI prefix and ZULU date
    const statusSuffix = activeTab === 0 ? 'Open' : 'Closed'
    const filename = `CUI_Maintenance_${statusSuffix}_${getZuluDateForFilename()}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export maintenance events to Excel with CUI markings
  const exportToExcel = () => {
    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = [`ACSS Maintenance Events Report - ${program ? `${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'}`]
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Status: ${activeTab === 0 ? 'Open Events (Backlog)' : 'Closed Events (History)'}`]
    const reportInfoRow4 = [`Total Events: ${pagination.total}`]

    // Filter info
    const filters: string[] = []
    if (eventTypeFilter) filters.push(`Event Type: ${eventTypeFilter}`)
    if (debouncedSearch) filters.push(`Search: "${debouncedSearch}"`)
    if (pqdrFilter) filters.push('PQDR Only')
    if (dateFromFilter) filters.push(`From: ${dateFromFilter}`)
    if (dateToFilter) filters.push(`To: ${dateToFilter}`)
    const filterRow = filters.length > 0 ? [`Filters: ${filters.join(', ')}`] : []

    // Table header row
    const headerRow = ['Job Number', 'Serial Number', 'Asset Name', 'Discrepancy', 'Event Type', 'Priority', 'Status', 'Base Location', 'Date In (ZULU)', 'Date Out (ZULU)', 'Days Open/Duration', 'Progress', 'PQDR Flag']

    // Data rows
    const dataRows = events.map(event => {
      const daysOpen = calculateDaysOpen(event.start_job, event.stop_job)
      // Format dates in ZULU
      const dateInZulu = event.start_job ? new Date(event.start_job).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : ''
      const dateOutZulu = event.stop_job ? new Date(event.stop_job).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : ''

      return [
        event.job_no,
        event.asset_sn,
        event.asset_name,
        event.discrepancy,
        event.event_type,
        event.priority,
        event.status.toUpperCase(),
        event.location,
        dateInZulu,
        dateOutZulu,
        `${daysOpen} day${daysOpen !== 1 ? 's' : ''}`,
        event.total_repairs !== undefined && event.total_repairs > 0
          ? `${event.progress_percentage}% (${event.closed_repairs}/${event.total_repairs} repairs)`
          : 'No repairs',
        event.pqdr ? 'Yes' : 'No'
      ]
    })

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']

    // Combine all rows
    const allRows = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      reportInfoRow3,
      reportInfoRow4,
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
      { wch: 15 },  // Job Number
      { wch: 15 },  // Serial Number
      { wch: 25 },  // Asset Name
      { wch: 50 },  // Discrepancy
      { wch: 12 },  // Event Type
      { wch: 10 },  // Priority
      { wch: 10 },  // Status
      { wch: 20 },  // Location
      { wch: 22 },  // Date In (ZULU)
      { wch: 22 },  // Date Out (ZULU)
      { wch: 15 },  // Days Open/Duration
      { wch: 30 },  // Progress
      { wch: 10 },  // PQDR Flag
    ]

    // Merge CUI header cells across all columns
    const numCols = headerRow.length
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
      { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
      { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
      { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Status
      { s: { r: 5, c: 0 }, e: { r: 5, c: numCols - 1 } }, // Total events
      { s: { r: allRows.length - 1, c: 0 }, e: { r: allRows.length - 1, c: numCols - 1 } }, // CUI footer
    ]

    // Add filter merge if applicable
    if (filterRow.length) {
      ws['!merges']!.push({ s: { r: 6, c: 0 }, e: { r: 6, c: numCols - 1 } })
    }

    // Add worksheet to workbook
    const statusSuffix = activeTab === 0 ? 'Open' : 'Closed'
    XLSX.utils.book_append_sheet(wb, ws, `Maintenance_${statusSuffix}`)

    // Generate filename with CUI prefix and ZULU date
    const filename = `CUI_Maintenance_${statusSuffix}_${getZuluDateForFilename()}.xlsx`

    // Write the file and trigger download
    XLSX.writeFile(wb, filename)
  }

  // Export PMI records to PDF with CUI markings and color coding
  const exportPMIToPdf = () => {
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

    // Helper to get status info with color
    const getPMIStatusInfo = (daysUntilDue: number): { label: string; color: [number, number, number]; bgColor: [number, number, number] } => {
      if (daysUntilDue < 0) {
        return { label: 'OVERDUE', color: [153, 27, 27], bgColor: [254, 226, 226] } // red-800, red-100
      }
      if (daysUntilDue <= 7) {
        return { label: 'DUE SOON', color: [153, 27, 27], bgColor: [254, 226, 226] } // red-800, red-100
      }
      if (daysUntilDue <= 30) {
        return { label: 'UPCOMING', color: [133, 77, 14], bgColor: [254, 249, 195] } // yellow-800, yellow-100
      }
      return { label: 'SCHEDULED', color: [22, 101, 52], bgColor: [220, 252, 231] } // green-800, green-100
    }

    // Add title section after header
    const addTitle = () => {
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 64, 175) // Primary blue
      doc.text('ACSS PMI Schedule Report', pageWidth / 2, 20, { align: 'center' })

      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(55, 65, 81) // Gray
      const programText = program ? `Program: ${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'
      doc.text(programText, pageWidth / 2, 27, { align: 'center' })

      doc.setFontSize(9)
      doc.text(`Report generated: ${zuluTimestamp}`, pageWidth / 2, 33, { align: 'center' })

      // Summary stats
      doc.text(`Total PMI Records: ${pmiRecords.length}`, pageWidth / 2, 38, { align: 'center' })

      // Add filter info if applied
      const filters: string[] = []
      if (pmiIntervalFilter) filters.push(`Interval: ${pmiIntervalFilter}-Day`)
      if (debouncedPmiSearch) filters.push(`Search: "${debouncedPmiSearch}"`)
      if (pmiOverdueOnly) filters.push('Overdue Only')

      if (filters.length > 0) {
        doc.setFontSize(8)
        doc.setTextColor(107, 114, 128)
        doc.text(`Filters: ${filters.join(', ')}`, pageWidth / 2, 43, { align: 'center' })
      }

      // Add color legend
      const legendY = filters.length > 0 ? 48 : 43
      doc.setFontSize(7)
      doc.setTextColor(107, 114, 128)
      doc.text('Status Legend:', 15, legendY)

      // Overdue (red)
      doc.setFillColor(254, 226, 226)
      doc.roundedRect(40, legendY - 3, 20, 5, 1, 1, 'F')
      doc.setTextColor(153, 27, 27)
      doc.text('OVERDUE', 42, legendY)

      // Due Soon (red)
      doc.setFillColor(254, 226, 226)
      doc.roundedRect(65, legendY - 3, 20, 5, 1, 1, 'F')
      doc.setTextColor(153, 27, 27)
      doc.text('DUE SOON', 66, legendY)

      // Upcoming (yellow)
      doc.setFillColor(254, 249, 195)
      doc.roundedRect(90, legendY - 3, 22, 5, 1, 1, 'F')
      doc.setTextColor(133, 77, 14)
      doc.text('UPCOMING', 92, legendY)

      // Scheduled (green)
      doc.setFillColor(220, 252, 231)
      doc.roundedRect(117, legendY - 3, 23, 5, 1, 1, 'F')
      doc.setTextColor(22, 101, 52)
      doc.text('SCHEDULED', 119, legendY)
    }

    // Prepare table data with status color info
    const tableData = pmiRecords.map(pmi => {
      const statusInfo = getPMIStatusInfo(pmi.days_until_due)
      return {
        data: [
          statusInfo.label,
          pmi.asset_sn,
          pmi.asset_name,
          pmi.pmi_type,
          `${pmi.interval_days}-Day`,
          pmi.wuc_cd,
          formatDateForExport(pmi.next_due_date),
          pmi.days_until_due < 0
            ? `${Math.abs(pmi.days_until_due)} days overdue`
            : `${pmi.days_until_due} days`,
          pmi.completed_date ? formatDateForExport(pmi.completed_date) : '-'
        ],
        statusInfo
      }
    })

    // Add header to first page
    addCuiHeader()
    addTitle()

    // Calculate start Y position based on filters
    const filters: string[] = []
    if (pmiIntervalFilter) filters.push(`Interval: ${pmiIntervalFilter}-Day`)
    if (debouncedPmiSearch) filters.push(`Search: "${debouncedPmiSearch}"`)
    if (pmiOverdueOnly) filters.push('Overdue Only')
    const startY = filters.length > 0 ? 53 : 48

    // Generate table with autoTable - with color coding preserved
    autoTable(doc, {
      startY: startY,
      head: [['Status', 'Serial #', 'Asset Name', 'PMI Type', 'Interval', 'WUC', 'Next Due Date', 'Days Until Due', 'Last Completed']],
      body: tableData.map(row => row.data),
      theme: 'striped',
      headStyles: {
        fillColor: [30, 64, 175], // Primary blue
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 8
      },
      bodyStyles: {
        fontSize: 7,
        textColor: [55, 65, 81]
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] // Light gray
      },
      margin: { top: 15, bottom: 15, left: 5, right: 5 },
      didDrawPage: () => {
        // Add CUI header on each page
        addCuiHeader()
      },
      // Style specific columns
      columnStyles: {
        0: { cellWidth: 22 },  // Status
        1: { cellWidth: 25 },  // Serial #
        2: { cellWidth: 40 },  // Asset Name
        3: { cellWidth: 45 },  // PMI Type
        4: { cellWidth: 20 },  // Interval
        5: { cellWidth: 20 },  // WUC
        6: { cellWidth: 30 },  // Next Due Date
        7: { cellWidth: 30 },  // Days Until Due
        8: { cellWidth: 30 },  // Last Completed
      },
      // Apply color coding to status column and days column
      didParseCell: (data) => {
        if (data.section === 'body') {
          const rowIndex = data.row.index
          const colIndex = data.column.index
          const rowData = tableData[rowIndex]

          // Status column (0) - apply color coding
          if (colIndex === 0 && rowData) {
            data.cell.styles.fillColor = rowData.statusInfo.bgColor
            data.cell.styles.textColor = rowData.statusInfo.color
            data.cell.styles.fontStyle = 'bold'
          }

          // Days Until Due column (7) - apply color coding
          if (colIndex === 7 && rowData) {
            data.cell.styles.textColor = rowData.statusInfo.color
            data.cell.styles.fontStyle = 'bold'
          }
        }
      }
    })

    // Get total pages and add footers
    const totalPages = doc.getNumberOfPages()
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i)
      addCuiFooter(i, totalPages)
    }

    // Generate filename with CUI prefix and ZULU date
    const filename = `CUI_PMI_Schedule_${getZuluDateForFilename()}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export PMI records to Excel with CUI markings
  const exportPMIToExcel = () => {
    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Helper to get status label
    const getPMIStatusLabel = (daysUntilDue: number): string => {
      if (daysUntilDue < 0) return 'OVERDUE'
      if (daysUntilDue <= 7) return 'DUE SOON'
      if (daysUntilDue <= 30) return 'UPCOMING'
      return 'SCHEDULED'
    }

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = [`ACSS PMI Schedule Report - ${program ? `${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'}`]
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Total PMI Records: ${pmiRecords.length}`]

    // Summary row
    const summaryRow = [`Summary: ${pmiSummary.overdue} Overdue | ${pmiSummary.red} Due Soon (7 days) | ${pmiSummary.yellow} Upcoming (30 days) | ${pmiSummary.green} Scheduled`]

    // Filter info
    const filters: string[] = []
    if (pmiIntervalFilter) filters.push(`Interval: ${pmiIntervalFilter}-Day`)
    if (debouncedPmiSearch) filters.push(`Search: "${debouncedPmiSearch}"`)
    if (pmiOverdueOnly) filters.push('Overdue Only')
    const filterRow = filters.length > 0 ? [`Filters: ${filters.join(', ')}`] : []

    // Table header row
    const headerRow = ['Status', 'Serial Number', 'Asset Name', 'PMI Type', 'Interval (Days)', 'WUC Code', 'Next Due Date (ZULU)', 'Days Until Due', 'Last Completed (ZULU)', 'Status Color']

    // Data rows
    const dataRows = pmiRecords.map(pmi => {
      const statusLabel = getPMIStatusLabel(pmi.days_until_due)
      // Format dates in ZULU
      const nextDueDateZulu = pmi.next_due_date ? new Date(pmi.next_due_date).toISOString().split('T')[0] + 'Z' : ''
      const completedDateZulu = pmi.completed_date ? new Date(pmi.completed_date).toISOString().split('T')[0] + 'Z' : ''

      // Color indicator for accessibility
      let colorIndicator = ''
      if (pmi.days_until_due < 0) colorIndicator = 'RED - Overdue'
      else if (pmi.days_until_due <= 7) colorIndicator = 'RED - Due within 7 days'
      else if (pmi.days_until_due <= 30) colorIndicator = 'YELLOW - Due within 30 days'
      else colorIndicator = 'GREEN - More than 30 days'

      return [
        statusLabel,
        pmi.asset_sn,
        pmi.asset_name,
        pmi.pmi_type,
        `${pmi.interval_days}`,
        pmi.wuc_cd,
        nextDueDateZulu,
        pmi.days_until_due < 0 ? `${Math.abs(pmi.days_until_due)} overdue` : `${pmi.days_until_due}`,
        completedDateZulu || '-',
        colorIndicator
      ]
    })

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']

    // Combine all rows
    const allRows = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      reportInfoRow3,
      summaryRow,
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
      { wch: 12 },  // Status
      { wch: 15 },  // Serial Number
      { wch: 25 },  // Asset Name
      { wch: 35 },  // PMI Type
      { wch: 15 },  // Interval (Days)
      { wch: 12 },  // WUC Code
      { wch: 20 },  // Next Due Date (ZULU)
      { wch: 15 },  // Days Until Due
      { wch: 20 },  // Last Completed (ZULU)
      { wch: 25 },  // Status Color
    ]

    // Merge CUI header cells across all columns
    const numCols = headerRow.length
    const headerRowIndex = filterRow.length ? 8 : 7

    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
      { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
      { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
      { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Total records
      { s: { r: 5, c: 0 }, e: { r: 5, c: numCols - 1 } }, // Summary
      { s: { r: allRows.length - 1, c: 0 }, e: { r: allRows.length - 1, c: numCols - 1 } }, // CUI footer
    ]

    // Add filter merge if applicable
    if (filterRow.length) {
      ws['!merges']!.push({ s: { r: 6, c: 0 }, e: { r: 6, c: numCols - 1 } })
    }

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'PMI_Schedule')

    // Generate filename with CUI prefix and ZULU date
    const filename = `CUI_PMI_Schedule_${getZuluDateForFilename()}.xlsx`

    // Write the file and trigger download
    XLSX.writeFile(wb, filename)
  }

  // Export TCTO records to PDF with CUI markings
  const exportTCTOToPdf = () => {
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

    // Helper to get status info with color
    const getTCTOStatusInfo = (daysUntilDeadline: number, status: string): { label: string; color: [number, number, number]; bgColor: [number, number, number] } => {
      if (status === 'closed') {
        return { label: 'COMPLETED', color: [22, 101, 52], bgColor: [220, 252, 231] } // green-800, green-100
      }
      if (daysUntilDeadline < 0) {
        return { label: 'OVERDUE', color: [153, 27, 27], bgColor: [254, 226, 226] } // red-800, red-100
      }
      if (daysUntilDeadline <= 7) {
        return { label: 'DUE SOON', color: [153, 27, 27], bgColor: [254, 226, 226] } // red-800, red-100
      }
      if (daysUntilDeadline <= 30) {
        return { label: 'UPCOMING', color: [133, 77, 14], bgColor: [254, 249, 195] } // yellow-800, yellow-100
      }
      return { label: 'ON TRACK', color: [22, 101, 52], bgColor: [220, 252, 231] } // green-800, green-100
    }

    // Add title section after header
    const addTitle = () => {
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 64, 175) // Primary blue
      doc.text('ACSS TCTO Report', pageWidth / 2, 20, { align: 'center' })

      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(55, 65, 81) // Gray
      const programText = program ? `Program: ${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'
      doc.text(programText, pageWidth / 2, 27, { align: 'center' })

      doc.setFontSize(9)
      doc.text(`Report generated: ${zuluTimestamp}`, pageWidth / 2, 33, { align: 'center' })

      // Summary stats
      doc.text(`Total TCTO Records: ${tctoRecords.length}`, pageWidth / 2, 38, { align: 'center' })

      // Add filter info if applied
      const filters: string[] = []
      if (debouncedTctoSearch) filters.push(`Search: "${debouncedTctoSearch}"`)
      if (tctoPriorityFilter) filters.push(`Priority: ${tctoPriorityFilter}`)
      if (tctoStatusFilter) filters.push(`Status: ${tctoStatusFilter}`)

      if (filters.length > 0) {
        doc.setFontSize(8)
        doc.setTextColor(107, 114, 128)
        doc.text(`Filters: ${filters.join(', ')}`, pageWidth / 2, 43, { align: 'center' })
      }

      // Add status legend
      const legendY = filters.length > 0 ? 48 : 43
      doc.setFontSize(7)
      doc.setTextColor(107, 114, 128)
      doc.text('Status Legend:', 15, legendY)

      // Overdue (red)
      doc.setFillColor(254, 226, 226)
      doc.roundedRect(40, legendY - 3, 20, 5, 1, 1, 'F')
      doc.setTextColor(153, 27, 27)
      doc.text('OVERDUE', 42, legendY)

      // Due Soon (red)
      doc.setFillColor(254, 226, 226)
      doc.roundedRect(65, legendY - 3, 20, 5, 1, 1, 'F')
      doc.setTextColor(153, 27, 27)
      doc.text('DUE SOON', 66, legendY)

      // Upcoming (yellow)
      doc.setFillColor(254, 249, 195)
      doc.roundedRect(90, legendY - 3, 22, 5, 1, 1, 'F')
      doc.setTextColor(133, 77, 14)
      doc.text('UPCOMING', 92, legendY)

      // On Track (green)
      doc.setFillColor(220, 252, 231)
      doc.roundedRect(117, legendY - 3, 23, 5, 1, 1, 'F')
      doc.setTextColor(22, 101, 52)
      doc.text('ON TRACK', 119, legendY)

      // Completed (green)
      doc.setFillColor(220, 252, 231)
      doc.roundedRect(145, legendY - 3, 25, 5, 1, 1, 'F')
      doc.setTextColor(22, 101, 52)
      doc.text('COMPLETED', 147, legendY)
    }

    // Prepare table data with status color info
    const tableData = tctoRecords.map(tcto => {
      const statusInfo = getTCTOStatusInfo(tcto.days_until_deadline, tcto.status)
      return {
        data: [
          statusInfo.label,
          tcto.tcto_no,
          tcto.title,
          tcto.priority,
          formatDateForExport(tcto.effective_date),
          formatDateForExport(tcto.compliance_deadline),
          tcto.status === 'closed' ? '-' :
            tcto.days_until_deadline < 0
              ? `${Math.abs(tcto.days_until_deadline)} days overdue`
              : `${tcto.days_until_deadline} days`,
          `${tcto.compliance_percentage}%`,
          `${tcto.compliant_assets.length}/${tcto.affected_assets.length}`
        ],
        statusInfo
      }
    })

    // Add header to first page
    addCuiHeader()
    addTitle()

    // Calculate start Y position based on filters
    const filters: string[] = []
    if (debouncedTctoSearch) filters.push(`Search: "${debouncedTctoSearch}"`)
    if (tctoPriorityFilter) filters.push(`Priority: ${tctoPriorityFilter}`)
    if (tctoStatusFilter) filters.push(`Status: ${tctoStatusFilter}`)
    const startY = filters.length > 0 ? 53 : 48

    // Generate table with autoTable - with color coding preserved
    autoTable(doc, {
      startY: startY,
      head: [['Status', 'TCTO Number', 'Title', 'Priority', 'Effective Date', 'Deadline', 'Days Until', 'Compliance', 'Assets']],
      body: tableData.map(row => row.data),
      theme: 'striped',
      headStyles: {
        fillColor: [30, 64, 175], // Primary blue
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 8
      },
      bodyStyles: {
        fontSize: 7,
        textColor: [55, 65, 81]
      },
      alternateRowStyles: {
        fillColor: [249, 250, 251] // Light gray
      },
      margin: { top: 15, bottom: 15, left: 5, right: 5 },
      didDrawPage: () => {
        // Add CUI header on each page
        addCuiHeader()
      },
      // Style specific columns
      columnStyles: {
        0: { cellWidth: 22 },  // Status
        1: { cellWidth: 28 },  // TCTO Number
        2: { cellWidth: 60 },  // Title
        3: { cellWidth: 20 },  // Priority
        4: { cellWidth: 25 },  // Effective Date
        5: { cellWidth: 25 },  // Deadline
        6: { cellWidth: 25 },  // Days Until
        7: { cellWidth: 20 },  // Compliance
        8: { cellWidth: 20 },  // Assets
      },
      // Apply color coding to status column
      didParseCell: (data) => {
        if (data.section === 'body') {
          const rowIndex = data.row.index
          const colIndex = data.column.index
          const rowData = tableData[rowIndex]

          // Status column (0) - apply color coding
          if (colIndex === 0 && rowData) {
            data.cell.styles.fillColor = rowData.statusInfo.bgColor
            data.cell.styles.textColor = rowData.statusInfo.color
            data.cell.styles.fontStyle = 'bold'
          }

          // Days Until column (6) - apply color coding
          if (colIndex === 6 && rowData) {
            data.cell.styles.textColor = rowData.statusInfo.color
            data.cell.styles.fontStyle = 'bold'
          }
        }
      }
    })

    // Get total pages and add footers
    const totalPages = doc.getNumberOfPages()
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i)
      addCuiFooter(i, totalPages)
    }

    // Generate filename with CUI prefix and ZULU date
    const filename = `CUI_TCTO_Report_${getZuluDateForFilename()}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  // Export TCTO records to Excel with CUI markings
  const exportTCTOToExcel = () => {
    const zuluTimestamp = getZuluTimestamp()

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()

    // Helper to get status label
    const getTCTOStatusLabel = (daysUntilDeadline: number, status: string): string => {
      if (status === 'closed') return 'COMPLETED'
      if (daysUntilDeadline < 0) return 'OVERDUE'
      if (daysUntilDeadline <= 7) return 'DUE SOON'
      if (daysUntilDeadline <= 30) return 'UPCOMING'
      return 'ON TRACK'
    }

    // Prepare data rows with CUI header
    const cuiHeaderRow = ['CONTROLLED UNCLASSIFIED INFORMATION (CUI)']
    const blankRow: string[] = []
    const reportInfoRow1 = [`ACSS TCTO Report - ${program ? `${program.pgm_cd} - ${program.pgm_name}` : 'All Programs'}`]
    const reportInfoRow2 = [`Generated: ${zuluTimestamp}`]
    const reportInfoRow3 = [`Total TCTO Records: ${tctoRecords.length}`]

    // Summary row
    const summaryRow = [`Summary: ${tctoSummary.open} Open | ${tctoSummary.closed} Completed | ${tctoSummary.overdue} Overdue | ${tctoSummary.critical} Critical | ${tctoSummary.urgent} Urgent | ${tctoSummary.routine} Routine`]

    // Filter info
    const filters: string[] = []
    if (debouncedTctoSearch) filters.push(`Search: "${debouncedTctoSearch}"`)
    if (tctoPriorityFilter) filters.push(`Priority: ${tctoPriorityFilter}`)
    if (tctoStatusFilter) filters.push(`Status: ${tctoStatusFilter}`)
    const filterRow = filters.length > 0 ? [`Filters: ${filters.join(', ')}`] : []

    // Table header row
    const headerRow = ['Status', 'TCTO Number', 'Title', 'Description', 'Priority', 'Effective Date (ZULU)', 'Compliance Deadline (ZULU)', 'Days Until Deadline', 'Compliance %', 'Compliant Assets', 'Total Assets', 'Status Color']

    // Data rows
    const dataRows = tctoRecords.map(tcto => {
      const statusLabel = getTCTOStatusLabel(tcto.days_until_deadline, tcto.status)
      // Format dates in ZULU
      const effectiveDateZulu = tcto.effective_date ? new Date(tcto.effective_date).toISOString().split('T')[0] + 'Z' : ''
      const deadlineZulu = tcto.compliance_deadline ? new Date(tcto.compliance_deadline).toISOString().split('T')[0] + 'Z' : ''

      // Color indicator for accessibility
      let colorIndicator = ''
      if (tcto.status === 'closed') colorIndicator = 'GREEN - Completed'
      else if (tcto.days_until_deadline < 0) colorIndicator = 'RED - Overdue'
      else if (tcto.days_until_deadline <= 7) colorIndicator = 'RED - Due within 7 days'
      else if (tcto.days_until_deadline <= 30) colorIndicator = 'YELLOW - Due within 30 days'
      else colorIndicator = 'GREEN - More than 30 days'

      return [
        statusLabel,
        tcto.tcto_no,
        tcto.title,
        tcto.description,
        tcto.priority,
        effectiveDateZulu,
        deadlineZulu,
        tcto.status === 'closed' ? '-' :
          tcto.days_until_deadline < 0 ? `${Math.abs(tcto.days_until_deadline)} overdue` : `${tcto.days_until_deadline}`,
        `${tcto.compliance_percentage}%`,
        tcto.compliant_assets.length.toString(),
        tcto.affected_assets.length.toString(),
        colorIndicator
      ]
    })

    // CUI footer row
    const cuiFooterRow = ['CUI - CONTROLLED UNCLASSIFIED INFORMATION']

    // Combine all rows
    const allRows = [
      cuiHeaderRow,
      blankRow,
      reportInfoRow1,
      reportInfoRow2,
      reportInfoRow3,
      summaryRow,
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
      { wch: 12 },  // Status
      { wch: 18 },  // TCTO Number
      { wch: 35 },  // Title
      { wch: 45 },  // Description
      { wch: 12 },  // Priority
      { wch: 20 },  // Effective Date (ZULU)
      { wch: 25 },  // Compliance Deadline (ZULU)
      { wch: 20 },  // Days Until Deadline
      { wch: 12 },  // Compliance %
      { wch: 15 },  // Compliant Assets
      { wch: 12 },  // Total Assets
      { wch: 25 },  // Status Color
    ]

    // Merge CUI header cells across all columns
    const numCols = headerRow.length
    const headerRowIndex = filterRow.length ? 8 : 7

    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }, // CUI header
      { s: { r: 2, c: 0 }, e: { r: 2, c: numCols - 1 } }, // Report title
      { s: { r: 3, c: 0 }, e: { r: 3, c: numCols - 1 } }, // Generated timestamp
      { s: { r: 4, c: 0 }, e: { r: 4, c: numCols - 1 } }, // Total records
      { s: { r: 5, c: 0 }, e: { r: 5, c: numCols - 1 } }, // Summary
      { s: { r: allRows.length - 1, c: 0 }, e: { r: allRows.length - 1, c: numCols - 1 } }, // CUI footer
    ]

    // Add filter merge if applicable
    if (filterRow.length) {
      ws['!merges']!.push({ s: { r: 6, c: 0 }, e: { r: 6, c: numCols - 1 } })
    }

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'TCTO_Report')

    // Generate filename with CUI prefix and ZULU date
    const filename = `CUI_TCTO_Report_${getZuluDateForFilename()}.xlsx`

    // Write the file and trigger download
    XLSX.writeFile(wb, filename)
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <WrenchScrewdriverIcon className="h-8 w-8 text-primary-600 mr-3" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Maintenance</h1>
              {program && (
                <p className="text-sm text-gray-500">
                  Viewing maintenance events for {program.pgm_cd} - {program.pgm_name}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Export PDF Button */}
            <button
              type="button"
              onClick={exportToPdf}
              disabled={events.length === 0}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export to PDF with CUI markings"
            >
              <IconAnimation type="scale">
                <DocumentArrowDownIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
              </IconAnimation>
              Export PDF
            </button>
            {/* Export Excel Button */}
            <button
              type="button"
              onClick={exportToExcel}
              disabled={events.length === 0}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export to Excel with CUI markings"
            >
              <IconAnimation type="scale">
                <svg className="-ml-1 mr-2 h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </IconAnimation>
              Export Excel
            </button>
            {canCreateEvent && (
              <button
                onClick={openNewEventModal}
                className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
              >
                <IconAnimation type="bounce">
                  <PlusIcon className="h-5 w-5 mr-2" />
                </IconAnimation>
                New Event
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <ExclamationCircleIcon className="h-8 w-8 text-red-500 mr-3" />
            <div>
              <p className="text-sm text-gray-500">Critical</p>
              <p className="text-2xl font-bold text-red-600">{summary.critical}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <ClockIcon className="h-8 w-8 text-orange-500 mr-3" />
            <div>
              <p className="text-sm text-gray-500">Urgent</p>
              <p className="text-2xl font-bold text-orange-600">{summary.urgent}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <WrenchScrewdriverIcon className="h-8 w-8 text-blue-500 mr-3" />
            <div>
              <p className="text-sm text-gray-500">Routine</p>
              <p className="text-2xl font-bold text-blue-600">{summary.routine}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <WrenchScrewdriverIcon className="h-8 w-8 text-yellow-500 mr-3" />
            <div>
              <p className="text-sm text-gray-500">Open Jobs</p>
              <p className="text-2xl font-bold text-yellow-600">{summary.open}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <CheckCircleIcon className="h-8 w-8 text-green-500 mr-3" />
            <div>
              <p className="text-sm text-gray-500">Closed Jobs</p>
              <p className="text-2xl font-bold text-green-600">{summary.closed}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="mb-6 space-y-4">
        {/* Row 1: Search and Event Type */}
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Search */}
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by job number, asset, discrepancy, or location..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          {/* Event Type Filter */}
          <div className="relative sm:w-56">
            <label htmlFor="event-type-filter" className="sr-only">Event Type Filter</label>
            <FunnelIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
            <select
              id="event-type-filter"
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-white"
            >
              <option value="">All Event Types</option>
              <option value="Standard">Standard</option>
              <option value="PMI">PMI (Periodic Maintenance)</option>
              <option value="TCTO">TCTO (Time Compliance)</option>
              <option value="BIT/PC">BIT/PC (Built-In Test)</option>
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </div>
          </div>
        </div>

        {/* Row 2: Date Range, PQDR, and Clear All Filters */}
        <div className="flex flex-col sm:flex-row gap-4 items-center">
          {/* Date Range Filter */}
          <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
            <CalendarIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-500 whitespace-nowrap">Date Range:</span>
            <input
              type="date"
              value={dateFromFilter}
              onChange={(e) => setDateFromFilter(e.target.value)}
              className="border-0 p-0 text-sm focus:ring-0 w-32 bg-transparent"
              placeholder="From"
            />
            <span className="text-gray-400">—</span>
            <input
              type="date"
              value={dateToFilter}
              onChange={(e) => setDateToFilter(e.target.value)}
              className="border-0 p-0 text-sm focus:ring-0 w-32 bg-transparent"
              placeholder="To"
            />
          </div>

          {/* PQDR Filter */}
          <label className={classNames(
            'flex items-center px-4 py-2 rounded-lg border cursor-pointer transition-colors',
            pqdrFilter
              ? 'bg-red-50 border-red-300 text-red-700'
              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
          )}>
            <input
              type="checkbox"
              checked={pqdrFilter}
              onChange={(e) => setPqdrFilter(e.target.checked)}
              className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
            />
            <ExclamationTriangleIcon className="h-5 w-5 ml-2 mr-1 text-red-500" />
            <span className="text-sm font-medium whitespace-nowrap">
              PQDR Only {summary.pqdr > 0 && <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{summary.pqdr}</span>}
            </span>
          </label>

          {/* Clear All Filters Button */}
          {(searchQuery || eventTypeFilter || pqdrFilter || dateFromFilter || dateToFilter) && (
            <button
              onClick={() => {
                setSearchQuery('')
                setEventTypeFilter('')
                setPqdrFilter(false)
                setDateFromFilter('')
                setDateToFilter('')
              }}
              className="flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <ArrowPathIcon className="h-4 w-4 mr-2" />
              Clear All Filters
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tab.Group selectedIndex={activeTab} onChange={setActiveTab}>
        <Tab.List className="flex space-x-1 rounded-xl bg-gray-100 p-1 mb-6">
          <Tab
            className={({ selected }) =>
              classNames(
                'w-full rounded-lg py-2.5 text-sm font-medium leading-5',
                'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-primary-400 ring-white ring-opacity-60',
                selected
                  ? 'bg-white shadow text-primary-700'
                  : 'text-gray-600 hover:bg-white/[0.12] hover:text-gray-700'
              )
            }
          >
            Backlog ({summary.open})
          </Tab>
          <Tab
            className={({ selected }) =>
              classNames(
                'w-full rounded-lg py-2.5 text-sm font-medium leading-5',
                'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-primary-400 ring-white ring-opacity-60',
                selected
                  ? 'bg-white shadow text-primary-700'
                  : 'text-gray-600 hover:bg-white/[0.12] hover:text-gray-700'
              )
            }
          >
            History ({summary.closed})
          </Tab>
          <Tab
            className={({ selected }) =>
              classNames(
                'w-full rounded-lg py-2.5 text-sm font-medium leading-5',
                'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-primary-400 ring-white ring-opacity-60',
                selected
                  ? 'bg-white shadow text-primary-700'
                  : 'text-gray-600 hover:bg-white/[0.12] hover:text-gray-700'
              )
            }
          >
            PMI Schedule ({pmiSummary.total})
          </Tab>
          <Tab
            className={({ selected }) =>
              classNames(
                'w-full rounded-lg py-2.5 text-sm font-medium leading-5',
                'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-primary-400 ring-white ring-opacity-60',
                selected
                  ? 'bg-white shadow text-primary-700'
                  : 'text-gray-600 hover:bg-white/[0.12] hover:text-gray-700'
              )
            }
          >
            TCTO ({tctoSummary.total})
          </Tab>
        </Tab.List>

        <Tab.Panels>
          {/* Backlog Tab */}
          <Tab.Panel>
            {/* View Mode Toggle - Only for Backlog */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">View:</span>
                <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                  <button
                    onClick={() => setViewMode('list')}
                    className={classNames(
                      'flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors',
                      viewMode === 'list'
                        ? 'bg-primary-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    )}
                    title="List View"
                  >
                    <QueueListIcon className="h-4 w-4" />
                    List
                  </button>
                  <button
                    onClick={() => setViewMode('grouped')}
                    className={classNames(
                      'flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors',
                      viewMode === 'grouped'
                        ? 'bg-primary-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    )}
                    title="Grouped by Configuration"
                  >
                    <Squares2X2Icon className="h-4 w-4" />
                    Grouped
                  </button>
                </div>
              </div>

              {/* Expand/Collapse All - Only visible in grouped view */}
              {viewMode === 'grouped' && events.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={expandAllGroups}
                    className="text-sm text-primary-600 hover:text-primary-800 font-medium"
                  >
                    Expand All
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    onClick={collapseAllGroups}
                    className="text-sm text-primary-600 hover:text-primary-800 font-medium"
                  >
                    Collapse All
                  </button>
                </div>
              )}
            </div>

            {viewMode === 'list' ? renderEventsTable() : renderGroupedView()}
          </Tab.Panel>

          {/* History Tab */}
          <Tab.Panel>
            {renderEventsTable()}
          </Tab.Panel>

          {/* PMI Schedule Tab */}
          <Tab.Panel>
            {renderPMITable()}
          </Tab.Panel>

          {/* TCTO Tab */}
          <Tab.Panel>
            {renderTCTOTable()}
          </Tab.Panel>
        </Tab.Panels>
      </Tab.Group>

      {/* New Event Modal */}
      <Dialog open={isNewEventModalOpen} onClose={closeNewEventModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Create New Maintenance Event
              </Dialog.Title>
              <button
                onClick={closeNewEventModal}
                className="text-gray-400 hover:text-gray-500"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              {/* Success Message */}
              {newEventSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{newEventSuccess}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {newEventError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-700 text-sm">{newEventError}</p>
                </div>
              )}

              {/* Asset Selection */}
              <div>
                <label htmlFor="asset_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Asset <span className="text-red-500">*</span>
                </label>
                <select
                  id="asset_id"
                  value={newEventForm.asset_id}
                  onChange={(e) => {
                    handleFormChange('asset_id', e.target.value)
                    // Clear field error when user corrects it
                    if (newEventFieldErrors.asset_id) {
                      setNewEventFieldErrors(prev => {
                        const newErrors = { ...prev }
                        delete newErrors.asset_id
                        return newErrors
                      })
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500 ${
                    newEventFieldErrors.asset_id
                      ? 'border-red-300 focus:border-red-500'
                      : 'border-gray-300 focus:border-primary-500'
                  }`}
                  disabled={assetsLoading}
                >
                  <option value="">Select an asset...</option>
                  {assets.map((asset) => (
                    <option key={asset.asset_id} value={asset.asset_id}>
                      {asset.serno} - {asset.name} ({asset.status_cd})
                    </option>
                  ))}
                </select>
                {assetsLoading && (
                  <p className="text-sm text-gray-500 mt-1">Loading assets...</p>
                )}
                {newEventFieldErrors.asset_id && (
                  <p className="mt-1 text-sm text-red-600">{newEventFieldErrors.asset_id}</p>
                )}
              </div>

              {/* Discrepancy Description */}
              <div>
                <label htmlFor="discrepancy" className="block text-sm font-medium text-gray-700 mb-1">
                  Discrepancy Description <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="discrepancy"
                  value={newEventForm.discrepancy}
                  onChange={(e) => {
                    handleFormChange('discrepancy', e.target.value)
                    // Clear field error when user corrects it
                    if (newEventFieldErrors.discrepancy) {
                      setNewEventFieldErrors(prev => {
                        const newErrors = { ...prev }
                        delete newErrors.discrepancy
                        return newErrors
                      })
                    }
                  }}
                  rows={3}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500 ${
                    newEventFieldErrors.discrepancy
                      ? 'border-red-300 focus:border-red-500'
                      : 'border-gray-300 focus:border-primary-500'
                  }`}
                  placeholder="Describe the maintenance issue or discrepancy..."
                />
                {newEventFieldErrors.discrepancy && (
                  <p className="mt-1 text-sm text-red-600">{newEventFieldErrors.discrepancy}</p>
                )}
              </div>

              {/* Event Type */}
              <div>
                <label htmlFor="event_type" className="block text-sm font-medium text-gray-700 mb-1">
                  Event Type <span className="text-red-500">*</span>
                </label>
                <select
                  id="event_type"
                  value={newEventForm.event_type}
                  onChange={(e) => handleFormChange('event_type', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="Standard">Standard</option>
                  <option value="PMI">PMI (Periodic Maintenance Inspection)</option>
                  <option value="TCTO">TCTO (Time Compliance Technical Order)</option>
                  <option value="BIT/PC">BIT/PC (Built-In Test / Pre-flight Check)</option>
                </select>
              </div>

              {/* Priority */}
              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-gray-700 mb-1">
                  Priority
                </label>
                <select
                  id="priority"
                  value={newEventForm.priority}
                  onChange={(e) => handleFormChange('priority', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="Routine">Routine</option>
                  <option value="Urgent">Urgent</option>
                  <option value="Critical">Critical</option>
                </select>
              </div>

              {/* Date In */}
              <div>
                <label htmlFor="start_job" className="block text-sm font-medium text-gray-700 mb-1">
                  Date In <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  id="start_job"
                  value={newEventForm.start_job}
                  onChange={(e) => {
                    handleFormChange('start_job', e.target.value)
                    // Clear field error when user corrects it
                    if (newEventFieldErrors.start_job) {
                      setNewEventFieldErrors(prev => {
                        const newErrors = { ...prev }
                        delete newErrors.start_job
                        return newErrors
                      })
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500 ${
                    newEventFieldErrors.start_job
                      ? 'border-red-300 focus:border-red-500'
                      : 'border-gray-300 focus:border-primary-500'
                  }`}
                />
                {newEventFieldErrors.start_job && (
                  <p className="mt-1 text-sm text-red-600">{newEventFieldErrors.start_job}</p>
                )}
              </div>

              {/* ETIC */}
              <div>
                <label htmlFor="etic" className="block text-sm font-medium text-gray-700 mb-1">
                  ETIC (Estimated Time In Commission)
                </label>
                <input
                  type="date"
                  id="etic"
                  value={newEventForm.etic}
                  onChange={(e) => handleFormChange('etic', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Optional"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Estimated date when the asset will be back in service
                </p>
              </div>

              {/* Base Location */}
              <div>
                <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-1">
                  Base Location
                </label>
                <input
                  type="text"
                  id="location"
                  value={newEventForm.location}
                  onChange={(e) => handleFormChange('location', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Auto-filled from asset, or enter custom location"
                />
              </div>

              {/* Sortie Selection */}
              <div>
                <label htmlFor="sortie_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Linked Sortie
                </label>
                <select
                  id="sortie_id"
                  value={newEventForm.sortie_id}
                  onChange={(e) => handleFormChange('sortie_id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={sortiesLoading}
                >
                  <option value="">No sortie linked (optional)</option>
                  {sorties.map((sortie) => (
                    <option key={sortie.sortie_id} value={sortie.sortie_id}>
                      {sortie.mission_id} - {sortie.serno} ({new Date(sortie.sortie_date).toLocaleDateString()})
                    </option>
                  ))}
                </select>
                {sortiesLoading && (
                  <p className="text-sm text-gray-500 mt-1">Loading sorties...</p>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Optionally link this event to a sortie that caused the discrepancy
                </p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <button
                onClick={closeNewEventModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={newEventLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitNewEvent}
                disabled={newEventLoading || !!newEventSuccess}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {newEventLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                    Creating...
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Create Event
                  </>
                )}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Delete Event Confirmation Modal */}
      <Dialog open={isDeleteModalOpen} onClose={closeDeleteModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-md w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Delete Maintenance Event
              </Dialog.Title>
              <button
                onClick={closeDeleteModal}
                className="text-gray-400 hover:text-gray-500"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6">
              {/* Success Message */}
              {deleteSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{deleteSuccess}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {deleteError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                  <p className="text-red-700 text-sm">{deleteError}</p>
                </div>
              )}

              {!deleteSuccess && (
                <>
                  {/* Warning */}
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                    <div className="flex items-center">
                      <ExclamationCircleIcon className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
                      <p className="text-red-700 text-sm">
                        Are you sure you want to delete this maintenance event? This action cannot be undone.
                        All related repairs will also be deleted.
                      </p>
                    </div>
                  </div>

                  {/* Event Details */}
                  {eventToDelete && (
                    <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Job Number:</span>
                        <span className="text-sm font-mono font-semibold text-primary-600">{eventToDelete.job_no}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Asset:</span>
                        <span className="text-sm font-medium text-gray-900">{eventToDelete.asset_sn} - {eventToDelete.asset_name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Status:</span>
                        <span className={classNames(
                          'text-xs font-medium px-2 py-0.5 rounded-full',
                          eventToDelete.status === 'open' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'
                        )}>
                          {eventToDelete.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Priority:</span>
                        <span className="text-sm text-gray-900">{eventToDelete.priority}</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Footer */}
            {!deleteSuccess && (
              <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
                <button
                  onClick={closeDeleteModal}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                  disabled={deleteLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteEvent}
                  disabled={deleteLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                >
                  {deleteLoading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <TrashIcon className="h-4 w-4 mr-2" />
                      Delete Event
                    </>
                  )}
                </button>
              </div>
            )}
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* New PMI Modal */}
      <Dialog open={isNewPMIModalOpen} onClose={closeNewPMIModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Create New PMI Schedule Entry
              </Dialog.Title>
              <button
                onClick={closeNewPMIModal}
                className="text-gray-400 hover:text-gray-500"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleCreatePMI} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Success Message */}
              {newPMISuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{newPMISuccess}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {newPMIError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-700 text-sm">{newPMIError}</p>
                </div>
              )}

              {/* Asset Selection */}
              <div>
                <label htmlFor="pmi_asset_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Asset <span className="text-red-500">*</span>
                </label>
                <select
                  id="pmi_asset_id"
                  value={newPMIForm.asset_id}
                  onChange={(e) => handlePMIFormChange('asset_id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  required
                  disabled={assetsLoading}
                >
                  <option value="">Select an asset...</option>
                  {assets.map((asset) => (
                    <option key={asset.asset_id} value={asset.asset_id}>
                      {asset.serno} - {asset.name}
                    </option>
                  ))}
                </select>
                {assetsLoading && (
                  <p className="text-sm text-gray-500 mt-1">Loading assets...</p>
                )}
              </div>

              {/* PMI Type */}
              <div>
                <label htmlFor="pmi_type" className="block text-sm font-medium text-gray-700 mb-1">
                  PMI Type <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="pmi_type"
                  value={newPMIForm.pmi_type}
                  onChange={(e) => handlePMIFormChange('pmi_type', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., 30-Day Inspection, 90-Day Calibration"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Describe the type of periodic maintenance (e.g., 30-Day Inspection, Annual Service)
                </p>
              </div>

              {/* Due Date */}
              <div>
                <label htmlFor="pmi_due_date" className="block text-sm font-medium text-gray-700 mb-1">
                  Due Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  id="pmi_due_date"
                  value={newPMIForm.next_due_date}
                  onChange={(e) => handlePMIFormChange('next_due_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  required
                />
              </div>

              {/* WUC (Work Unit Code) */}
              <div>
                <label htmlFor="pmi_wuc" className="block text-sm font-medium text-gray-700 mb-1">
                  WUC (Work Unit Code)
                </label>
                <input
                  type="text"
                  id="pmi_wuc"
                  value={newPMIForm.wuc_cd}
                  onChange={(e) => handlePMIFormChange('wuc_cd', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., 14AAA"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Optional work unit code for maintenance tracking
                </p>
              </div>

              {/* Interval Days */}
              <div>
                <label htmlFor="pmi_interval" className="block text-sm font-medium text-gray-700 mb-1">
                  Interval (Days)
                </label>
                <select
                  id="pmi_interval"
                  value={newPMIForm.interval_days}
                  onChange={(e) => handlePMIFormChange('interval_days', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="30">30-Day</option>
                  <option value="60">60-Day</option>
                  <option value="90">90-Day</option>
                  <option value="180">180-Day</option>
                  <option value="365">365-Day (Annual)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Standard recurring interval for this PMI
                </p>
              </div>
            </form>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <button
                onClick={closeNewPMIModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={newPMILoading}
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePMI}
                disabled={newPMILoading || !!newPMISuccess}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {newPMILoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                    Creating...
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Create PMI
                  </>
                )}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* New TCTO Modal */}
      <Dialog open={isNewTCTOModalOpen} onClose={closeNewTCTOModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Create New TCTO
              </Dialog.Title>
              <button
                onClick={closeNewTCTOModal}
                className="text-gray-400 hover:text-gray-500"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleCreateTCTO} className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              {/* Success Message */}
              {newTCTOSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{newTCTOSuccess}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {newTCTOError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-700 text-sm">{newTCTOError}</p>
                </div>
              )}

              {/* TCTO Number */}
              <div>
                <label htmlFor="tcto_no" className="block text-sm font-medium text-gray-700 mb-1">
                  TCTO Number <span className="text-red-500">*</span>
                </label>
                <input
                  id="tcto_no"
                  type="text"
                  value={newTCTOForm.tcto_no}
                  onChange={(e) => handleTCTOFormChange('tcto_no', e.target.value)}
                  placeholder="e.g., TCTO-2024-006"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
              </div>

              {/* Title */}
              <div>
                <label htmlFor="tcto_title" className="block text-sm font-medium text-gray-700 mb-1">
                  Title <span className="text-red-500">*</span>
                </label>
                <input
                  id="tcto_title"
                  type="text"
                  value={newTCTOForm.title}
                  onChange={(e) => handleTCTOFormChange('title', e.target.value)}
                  placeholder="e.g., Firmware Update for Sensor Module"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
              </div>

              {/* TCTO Type and System Type in a row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tcto_type" className="block text-sm font-medium text-gray-700 mb-1">
                    TCTO Type
                  </label>
                  <select
                    id="tcto_type"
                    value={newTCTOForm.tcto_type}
                    onChange={(e) => handleTCTOFormChange('tcto_type', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    disabled={newTCTOLoading || !!newTCTOSuccess}
                  >
                    <option value="">Select type...</option>
                    <option value="Software">Software</option>
                    <option value="Hardware">Hardware</option>
                    <option value="Firmware">Firmware</option>
                    <option value="Calibration">Calibration</option>
                    <option value="Modification">Modification</option>
                    <option value="Inspection">Inspection</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="sys_type" className="block text-sm font-medium text-gray-700 mb-1">
                    System Type
                  </label>
                  <select
                    id="sys_type"
                    value={newTCTOForm.sys_type}
                    onChange={(e) => handleTCTOFormChange('sys_type', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    disabled={newTCTOLoading || !!newTCTOSuccess}
                  >
                    <option value="">Select system...</option>
                    <option value="Sensor">Sensor</option>
                    <option value="Radar">Radar</option>
                    <option value="Camera">Camera</option>
                    <option value="Communication">Communication</option>
                    <option value="Navigation">Navigation</option>
                    <option value="Power">Power</option>
                    <option value="All">All Systems</option>
                  </select>
                </div>
              </div>

              {/* Effective Date */}
              <div>
                <label htmlFor="effective_date" className="block text-sm font-medium text-gray-700 mb-1">
                  Effective Date <span className="text-red-500">*</span>
                </label>
                <input
                  id="effective_date"
                  type="date"
                  value={newTCTOForm.effective_date}
                  onChange={(e) => handleTCTOFormChange('effective_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
                <p className="text-xs text-gray-500 mt-1">Date the TCTO becomes effective</p>
              </div>

              {/* Compliance Deadline */}
              <div>
                <label htmlFor="compliance_deadline" className="block text-sm font-medium text-gray-700 mb-1">
                  Compliance Deadline <span className="text-red-500">*</span>
                </label>
                <input
                  id="compliance_deadline"
                  type="date"
                  value={newTCTOForm.compliance_deadline}
                  onChange={(e) => handleTCTOFormChange('compliance_deadline', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
                <p className="text-xs text-gray-500 mt-1">Final deadline for all assets to be compliant</p>
              </div>

              {/* Priority */}
              <div>
                <label htmlFor="tcto_priority" className="block text-sm font-medium text-gray-700 mb-1">
                  Priority <span className="text-red-500">*</span>
                </label>
                <select
                  id="tcto_priority"
                  value={newTCTOForm.priority}
                  onChange={(e) => handleTCTOFormChange('priority', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                >
                  <option value="Routine">Routine</option>
                  <option value="Urgent">Urgent</option>
                  <option value="Critical">Critical</option>
                </select>
              </div>

              {/* Description */}
              <div>
                <label htmlFor="tcto_description" className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  id="tcto_description"
                  rows={3}
                  value={newTCTOForm.description}
                  onChange={(e) => handleTCTOFormChange('description', e.target.value)}
                  placeholder="Detailed description of the TCTO..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
              </div>

              {/* Remarks */}
              <div>
                <label htmlFor="tcto_remarks" className="block text-sm font-medium text-gray-700 mb-1">
                  Remarks
                </label>
                <textarea
                  id="tcto_remarks"
                  rows={2}
                  value={newTCTOForm.remarks}
                  onChange={(e) => handleTCTOFormChange('remarks', e.target.value)}
                  placeholder="Additional notes or remarks..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={newTCTOLoading || !!newTCTOSuccess}
                />
              </div>
            </form>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <button
                onClick={closeNewTCTOModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={newTCTOLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTCTO}
                disabled={newTCTOLoading || !!newTCTOSuccess}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {newTCTOLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                    Creating...
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Create TCTO
                  </>
                )}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Edit TCTO Modal */}
      <Dialog open={isEditTCTOModalOpen} onClose={closeEditTCTOModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Edit TCTO {tctoToEdit?.tcto_no}
              </Dialog.Title>
              <button
                onClick={closeEditTCTOModal}
                className="text-gray-400 hover:text-gray-500"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <form className="p-6 space-y-4 max-h-[60vh] overflow-y-auto" onSubmit={handleEditTCTOSubmit}>
              {/* Error Message */}
              {editTCTOError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  {editTCTOError}
                </div>
              )}

              {/* Success Message */}
              {editTCTOSuccess && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-600 text-sm">
                  {editTCTOSuccess}
                </div>
              )}

              {/* TCTO Info Display */}
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <h4 className="text-sm font-medium text-gray-700 mb-2">TCTO Information</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">TCTO Number:</span>
                    <span className="ml-2 font-medium">{tctoToEdit?.tcto_no}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Title:</span>
                    <span className="ml-2 font-medium">{tctoToEdit?.title}</span>
                  </div>
                </div>
              </div>

              {/* Effective Date */}
              <div>
                <label htmlFor="edit_effective_date" className="block text-sm font-medium text-gray-700 mb-1">
                  Effective Date <span className="text-red-500">*</span>
                </label>
                <input
                  id="edit_effective_date"
                  type="date"
                  value={editTCTOForm.effective_date}
                  onChange={(e) => setEditTCTOForm({ ...editTCTOForm, effective_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={editTCTOLoading || !!editTCTOSuccess}
                />
              </div>

              {/* Compliance Deadline */}
              <div>
                <label htmlFor="edit_compliance_deadline" className="block text-sm font-medium text-gray-700 mb-1">
                  Compliance Deadline <span className="text-red-500">*</span>
                </label>
                <input
                  id="edit_compliance_deadline"
                  type="date"
                  value={editTCTOForm.compliance_deadline}
                  onChange={(e) => setEditTCTOForm({ ...editTCTOForm, compliance_deadline: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={editTCTOLoading || !!editTCTOSuccess}
                />
              </div>

              {/* Priority */}
              <div>
                <label htmlFor="edit_tcto_priority" className="block text-sm font-medium text-gray-700 mb-1">
                  Priority <span className="text-red-500">*</span>
                </label>
                <select
                  id="edit_tcto_priority"
                  value={editTCTOForm.priority}
                  onChange={(e) => setEditTCTOForm({ ...editTCTOForm, priority: e.target.value as 'Routine' | 'Urgent' | 'Critical' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={editTCTOLoading || !!editTCTOSuccess}
                >
                  <option value="Routine">Routine</option>
                  <option value="Urgent">Urgent</option>
                  <option value="Critical">Critical</option>
                </select>
              </div>

              {/* Status */}
              <div>
                <label htmlFor="edit_tcto_status" className="block text-sm font-medium text-gray-700 mb-1">
                  Status <span className="text-red-500">*</span>
                </label>
                <select
                  id="edit_tcto_status"
                  value={editTCTOForm.status}
                  onChange={(e) => setEditTCTOForm({ ...editTCTOForm, status: e.target.value as 'open' | 'closed' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={editTCTOLoading || !!editTCTOSuccess}
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              {/* Description / Remarks */}
              <div>
                <label htmlFor="edit_tcto_description" className="block text-sm font-medium text-gray-700 mb-1">
                  Remarks
                </label>
                <textarea
                  id="edit_tcto_description"
                  rows={3}
                  value={editTCTOForm.description}
                  onChange={(e) => setEditTCTOForm({ ...editTCTOForm, description: e.target.value })}
                  placeholder="Additional remarks or notes..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  disabled={editTCTOLoading || !!editTCTOSuccess}
                />
              </div>
            </form>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <button
                onClick={closeEditTCTOModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={editTCTOLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleEditTCTOSubmit}
                disabled={editTCTOLoading || !!editTCTOSuccess}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {editTCTOLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircleIcon className="h-4 w-4 mr-2" />
                    Save Changes
                  </>
                )}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Delete TCTO Confirmation Modal */}
      <Dialog open={isDeleteTCTOModalOpen} onClose={closeDeleteTCTOModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="mx-auto max-w-md w-full bg-white rounded-xl shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <Dialog.Title className="text-lg font-semibold text-red-600 flex items-center">
                <ExclamationTriangleIcon className="h-6 w-6 mr-2" />
                Delete TCTO
              </Dialog.Title>
              <button
                onClick={closeDeleteTCTOModal}
                className="text-gray-400 hover:text-gray-500"
                disabled={deleteTCTOLoading}
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6">
              {/* Success Message */}
              {deleteTCTOSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                  <div className="flex items-center">
                    <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2" />
                    <p className="text-green-700">{deleteTCTOSuccess}</p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {deleteTCTOError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                  <p className="text-red-700 text-sm">{deleteTCTOError}</p>
                </div>
              )}

              {!deleteTCTOSuccess && (
                <>
                  {/* Warning */}
                  <div className="mb-4">
                    <p className="text-gray-700">
                      Are you sure you want to delete this TCTO record? This action cannot be undone.
                    </p>
                  </div>

                  {/* TCTO Details */}
                  {tctoToDelete && (
                    <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">TCTO Number:</span>
                        <span className="text-sm font-mono font-semibold text-indigo-600">{tctoToDelete.tcto_no}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Title:</span>
                        <span className="text-sm font-medium text-gray-900 text-right max-w-[200px] truncate">{tctoToDelete.title}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Status:</span>
                        <span className={classNames(
                          'text-xs font-medium px-2 py-0.5 rounded-full',
                          tctoToDelete.status === 'open' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                        )}>
                          {tctoToDelete.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Priority:</span>
                        <span className="text-sm text-gray-900">{tctoToDelete.priority}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-500">Deadline:</span>
                        <span className="text-sm text-gray-900">{tctoToDelete.compliance_deadline}</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Footer */}
            {!deleteTCTOSuccess && (
              <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-xl">
                <button
                  onClick={closeDeleteTCTOModal}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                  disabled={deleteTCTOLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteTCTO}
                  disabled={deleteTCTOLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                >
                  {deleteTCTOLoading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <TrashIcon className="h-4 w-4 mr-2" />
                      Delete TCTO
                    </>
                  )}
                </button>
              </div>
            )}
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  )

  function renderEventsTable() {
    if (loading) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          </div>
        </div>
      )
    }

    if (error) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => fetchEvents(1, activeTab === 0 ? 'open' : 'closed')}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )
    }

    if (events.length === 0) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <EmptyMaintenanceIllustration
            title={activeTab === 0 ? 'No open maintenance jobs' : 'No closed maintenance jobs'}
            subtitle={activeTab === 0
              ? 'All systems operational - nothing requires attention at the moment'
              : 'No completed maintenance records match your current filters'}
            size="md"
            className="py-4"
          />
        </div>
      )
    }

    return (
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Job #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Asset
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Discrepancy
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Priority
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Base Location
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Started
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Days {activeTab === 0 ? 'Open' : 'Duration'}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Progress
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                {canDeleteEvent && (
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {events.map((event) => {
                const priorityStyle = priorityColors[event.priority] || priorityColors.Routine
                const eventTypeStyle = eventTypeColors[event.event_type] || eventTypeColors.Standard
                const statusStyle = statusColors[event.status] || statusColors.open
                const daysOpen = calculateDaysOpen(event.start_job, event.stop_job)

                return (
                  <tr
                    key={event.event_id}
                    className={classNames(
                      'cursor-pointer transition-colors',
                      event.pqdr ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'
                    )}
                    onClick={() => handleEventClick(event.event_id)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono font-semibold text-primary-600">
                          {event.job_no}
                        </span>
                        {event.pqdr && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-500 text-white" title="Product Quality Deficiency Report">
                            PQDR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{event.asset_name}</div>
                        <div className="text-sm text-gray-500 font-mono">{event.asset_sn}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 max-w-xs truncate" title={event.discrepancy}>
                        {event.discrepancy}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={classNames(
                        'px-2 py-1 text-xs font-medium rounded-full border',
                        eventTypeStyle.bg,
                        eventTypeStyle.text,
                        eventTypeStyle.border
                      )}>
                        {event.event_type}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={classNames(
                        'px-2 py-1 text-xs font-medium rounded-full border',
                        priorityStyle.bg,
                        priorityStyle.text,
                        priorityStyle.border
                      )}>
                        {event.priority}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-600">{event.location}</span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-600">{formatDate(event.start_job)}</span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={classNames(
                        'text-sm font-medium',
                        daysOpen > 7 ? 'text-red-600' : daysOpen > 3 ? 'text-orange-600' : 'text-gray-600'
                      )}>
                        {daysOpen} {daysOpen === 1 ? 'day' : 'days'}
                      </span>
                    </td>
                    <td className="px-6 py-4 min-w-[180px]">
                      {event.total_repairs !== undefined && event.total_repairs > 0 ? (
                        <ProgressBar
                          percentage={event.progress_percentage || 0}
                          totalRepairs={event.total_repairs}
                          closedRepairs={event.closed_repairs || 0}
                        />
                      ) : (
                        <span className="text-xs text-gray-400">No repairs</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={classNames(
                        'px-2 py-1 text-xs font-medium rounded-full border',
                        statusStyle.bg,
                        statusStyle.text,
                        statusStyle.border
                      )}>
                        {event.status.toUpperCase()}
                      </span>
                    </td>
                    {canDeleteEvent && (
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <button
                          onClick={(e) => openDeleteModal(event, e)}
                          className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50 transition-colors"
                          title={`Delete ${event.job_no}`}
                          aria-label={`Delete ${event.job_no}`}
                        >
                          <TrashIcon className="h-5 w-5" aria-hidden="true" />
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
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
                  of <span className="font-medium">{pagination.total}</span> events
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
                    <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                  {/* Page numbers */}
                  {Array.from({ length: pagination.total_pages }, (_, i) => i + 1).map((pageNum) => (
                    <button
                      key={pageNum}
                      onClick={() => handlePageChange(pageNum)}
                      className={classNames(
                        'relative inline-flex items-center px-4 py-2 border text-sm font-medium',
                        pageNum === pagination.page
                          ? 'z-10 bg-primary-50 border-primary-500 text-primary-600'
                          : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                      )}
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
                    <ChevronRightIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}

        {/* Total count */}
        {pagination.total_pages <= 1 && (
          <div className="bg-white px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-500">{pagination.total} total events</p>
          </div>
        )}
      </div>
    )
  }

  function renderGroupedView() {
    if (loading) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          </div>
        </div>
      )
    }

    if (error) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => fetchEvents(1, 'open')}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )
    }

    if (events.length === 0) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <EmptyMaintenanceIllustration
            title="No open maintenance jobs"
            subtitle="All systems operational - nothing requires attention at the moment"
            size="md"
            className="py-4"
          />
        </div>
      )
    }

    const groupedEvents = groupEventsByConfiguration(events)
    const totalGroups = groupedEvents.length

    return (
      <div className="space-y-3">
        {/* Group Summary */}
        <div className="bg-gray-50 rounded-lg px-4 py-2 text-sm text-gray-600">
          {totalGroups} configuration{totalGroups !== 1 ? 's' : ''} with {events.length} open event{events.length !== 1 ? 's' : ''}
        </div>

        {/* Configuration Groups */}
        {groupedEvents.map(([configName, configEvents]) => {
          const isExpanded = expandedGroups.has(configName)
          const criticalCount = configEvents.filter(e => e.priority === 'Critical').length
          const urgentCount = configEvents.filter(e => e.priority === 'Urgent').length
          const routineCount = configEvents.filter(e => e.priority === 'Routine').length
          const pqdrCount = configEvents.filter(e => e.pqdr).length

          // Get unique serial numbers for this configuration
          const serialNumbers = [...new Set(configEvents.map(e => e.asset_sn))]

          return (
            <div key={configName} className="bg-white shadow rounded-lg overflow-hidden">
              {/* Group Header (Accordion Toggle) */}
              <button
                onClick={() => toggleGroup(configName)}
                className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors border-b border-gray-200"
              >
                <div className="flex items-center gap-4">
                  {/* Expand/Collapse Icon */}
                  {isExpanded ? (
                    <ChevronUpIcon className="h-5 w-5 text-gray-500" />
                  ) : (
                    <ChevronDownIcon className="h-5 w-5 text-gray-500" />
                  )}

                  {/* Configuration Name */}
                  <div className="text-left">
                    <div className="text-lg font-semibold text-gray-900">{configName}</div>
                    <div className="text-sm text-gray-500">
                      {serialNumbers.length} unit{serialNumbers.length !== 1 ? 's' : ''}: {serialNumbers.slice(0, 3).join(', ')}
                      {serialNumbers.length > 3 && ` +${serialNumbers.length - 3} more`}
                    </div>
                  </div>
                </div>

                {/* Priority Summary Badges */}
                <div className="flex items-center gap-3">
                  {pqdrCount > 0 && (
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-red-500 text-white">
                      {pqdrCount} PQDR
                    </span>
                  )}
                  {criticalCount > 0 && (
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                      {criticalCount} Critical
                    </span>
                  )}
                  {urgentCount > 0 && (
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                      {urgentCount} Urgent
                    </span>
                  )}
                  {routineCount > 0 && (
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {routineCount} Routine
                    </span>
                  )}
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-primary-100 text-primary-800">
                    {configEvents.length} event{configEvents.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </button>

              {/* Expanded Events List */}
              {isExpanded && (
                <div className="divide-y divide-gray-100">
                  {configEvents.map((event) => {
                    const priorityStyle = priorityColors[event.priority] || priorityColors.Routine
                    const eventTypeStyle = eventTypeColors[event.event_type] || eventTypeColors.Standard
                    const daysOpen = calculateDaysOpen(event.start_job, event.stop_job)

                    return (
                      <div
                        key={event.event_id}
                        className={classNames(
                          'px-6 py-4 cursor-pointer transition-colors',
                          event.pqdr ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'
                        )}
                        onClick={() => handleEventClick(event.event_id)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 mb-1">
                              {/* Job Number */}
                              <span className="text-sm font-mono font-semibold text-primary-600">
                                {event.job_no}
                              </span>
                              {/* Serial Number */}
                              <span className="text-sm font-mono text-gray-500">
                                {event.asset_sn}
                              </span>
                              {/* PQDR Badge */}
                              {event.pqdr && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-500 text-white">
                                  PQDR
                                </span>
                              )}
                            </div>
                            {/* Discrepancy */}
                            <p className="text-sm text-gray-700 mb-2 line-clamp-2">
                              {event.discrepancy}
                            </p>
                            {/* Metadata Row */}
                            <div className="flex items-center gap-4 text-xs text-gray-500">
                              <span className="flex items-center gap-1">
                                <ClockIcon className="h-3.5 w-3.5" />
                                {formatDate(event.start_job)}
                              </span>
                              <span className={classNames(
                                'font-medium',
                                daysOpen > 7 ? 'text-red-600' : daysOpen > 3 ? 'text-orange-600' : 'text-gray-600'
                              )}>
                                {daysOpen} day{daysOpen !== 1 ? 's' : ''} open
                              </span>
                              <span>{event.location}</span>
                            </div>
                          </div>
                          {/* Right Side: Badges and Actions */}
                          <div className="flex items-center gap-3 ml-4">
                            {/* Event Type Badge */}
                            <span className={classNames(
                              'px-2 py-1 text-xs font-medium rounded-full border',
                              eventTypeStyle.bg,
                              eventTypeStyle.text,
                              eventTypeStyle.border
                            )}>
                              {event.event_type}
                            </span>
                            {/* Priority Badge */}
                            <span className={classNames(
                              'px-2 py-1 text-xs font-medium rounded-full border',
                              priorityStyle.bg,
                              priorityStyle.text,
                              priorityStyle.border
                            )}>
                              {event.priority}
                            </span>
                            {/* Delete Button (Admin only) */}
                            {canDeleteEvent && (
                              <button
                                onClick={(e) => openDeleteModal(event, e)}
                                className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50 transition-colors"
                                title={`Delete ${event.job_no}`}
                              >
                                <TrashIcon className="h-5 w-5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Pagination note for grouped view */}
        {pagination.total > events.length && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-sm text-yellow-800">
            <strong>Note:</strong> Showing {events.length} of {pagination.total} total events.
            Switch to List View for full pagination controls.
          </div>
        )}
      </div>
    )
  }

  function renderPMITable() {
    if (pmiLoading) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          </div>
        </div>
      )
    }

    if (pmiError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-600">{pmiError}</p>
          <button
            onClick={fetchPMI}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )
    }

    if (pmiRecords.length === 0) {
      return (
        <div className="space-y-6">
          {/* Add PMI Button */}
          {canCreatePMI && (
            <div className="flex justify-end">
              <button
                onClick={openNewPMIModal}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
              >
                <PlusIcon className="h-5 w-5" />
                Add PMI
              </button>
            </div>
          )}
          <div className="bg-white shadow rounded-lg p-8 text-center">
            <CalendarIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">
              {(debouncedPmiSearch || pmiIntervalFilter || pmiOverdueOnly)
                ? 'No PMI schedule entries match your filters.'
                : 'No PMI schedule entries found for the current program.'}
            </p>
            {(debouncedPmiSearch || pmiIntervalFilter || pmiOverdueOnly) && (
              <button
                onClick={() => {
                  setPmiSearchQuery('')
                  setPmiIntervalFilter('')
                  setPmiOverdueOnly(false)
                }}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <XMarkIcon className="h-5 w-5" />
                Clear Filters
              </button>
            )}
            {canCreatePMI && !(debouncedPmiSearch || pmiIntervalFilter || pmiOverdueOnly) && (
              <button
                onClick={openNewPMIModal}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
              >
                <PlusIcon className="h-5 w-5" />
                Create First PMI
              </button>
            )}
          </div>
        </div>
      )
    }

    // PMI status color helpers
    const getPMIStatusStyle = (status: string, daysUntilDue: number) => {
      if (status === 'overdue' || daysUntilDue < 0) {
        return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', label: 'OVERDUE' }
      }
      if (daysUntilDue <= 7) {
        return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', label: 'DUE SOON' }
      }
      if (daysUntilDue <= 30) {
        return { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', label: 'UPCOMING' }
      }
      return { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', label: 'SCHEDULED' }
    }

    return (
      <div className="space-y-6">
        {/* Search and Filter Row */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search by asset S/N, name, or PMI type..."
              value={pmiSearchQuery}
              onChange={(e) => setPmiSearchQuery(e.target.value)}
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
            />
            {pmiSearchQuery && (
              <button
                onClick={() => setPmiSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
              >
                <XMarkIcon className="h-5 w-5 text-gray-400 hover:text-gray-600" />
              </button>
            )}
          </div>

          {/* Filters and Actions */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Overdue Only Toggle */}
            <button
              onClick={() => setPmiOverdueOnly(!pmiOverdueOnly)}
              className={classNames(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                pmiOverdueOnly
                  ? 'bg-red-100 text-red-800 border border-red-300'
                  : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
              )}
            >
              <ExclamationCircleIcon className="h-5 w-5" />
              Overdue Only
              {pmiOverdueOnly && pmiSummary.overdue > 0 && (
                <span className="bg-red-600 text-white text-xs px-1.5 py-0.5 rounded-full">
                  {pmiSummary.overdue}
                </span>
              )}
            </button>

            {/* PMI Interval Filter */}
            <div className="flex items-center gap-2">
              <label htmlFor="pmi_interval_filter" className="text-sm font-medium text-gray-700">
                Interval:
              </label>
              <select
                id="pmi_interval_filter"
                value={pmiIntervalFilter}
                onChange={(e) => setPmiIntervalFilter(e.target.value)}
                className="rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
              >
                <option value="">All</option>
                <option value="30">30-Day</option>
                <option value="60">60-Day</option>
                <option value="90">90-Day</option>
                <option value="180">180-Day</option>
                <option value="365">365-Day</option>
              </select>
            </div>

            {/* Clear All Filters */}
            {(pmiSearchQuery || pmiIntervalFilter || pmiOverdueOnly) && (
              <button
                onClick={() => {
                  setPmiSearchQuery('')
                  setPmiIntervalFilter('')
                  setPmiOverdueOnly(false)
                }}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Clear All
              </button>
            )}

            {/* Add PMI Button */}
            {canCreatePMI && (
              <button
                onClick={openNewPMIModal}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
              >
                <PlusIcon className="h-5 w-5" />
                Add PMI
              </button>
            )}

            {/* Export PDF Button */}
            <button
              type="button"
              onClick={exportPMIToPdf}
              disabled={pmiRecords.length === 0}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export PMI to PDF with CUI markings"
            >
              <DocumentArrowDownIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
              Export PDF
            </button>

            {/* Export Excel Button */}
            <button
              type="button"
              onClick={exportPMIToExcel}
              disabled={pmiRecords.length === 0}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export PMI to Excel with CUI markings"
            >
              <DocumentArrowDownIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
              Export Excel
            </button>
          </div>
        </div>

        {/* PMI Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <ExclamationCircleIcon className="h-8 w-8 text-red-500 mr-3" />
              <div>
                <p className="text-sm text-gray-500">Overdue</p>
                <p className="text-2xl font-bold text-red-600">{pmiSummary.overdue}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <ClockIcon className="h-8 w-8 text-red-500 mr-3" />
              <div>
                <p className="text-sm text-gray-500">Due Soon (7 days)</p>
                <p className="text-2xl font-bold text-red-600">{pmiSummary.red}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <ClockIcon className="h-8 w-8 text-yellow-500 mr-3" />
              <div>
                <p className="text-sm text-gray-500">Upcoming (30 days)</p>
                <p className="text-2xl font-bold text-yellow-600">{pmiSummary.yellow}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <CheckCircleIcon className="h-8 w-8 text-green-500 mr-3" />
              <div>
                <p className="text-sm text-gray-500">Scheduled</p>
                <p className="text-2xl font-bold text-green-600">{pmiSummary.green}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <CalendarIcon className="h-8 w-8 text-primary-500 mr-3" />
              <div>
                <p className="text-sm text-gray-500">Total PMI</p>
                <p className="text-2xl font-bold text-primary-600">{pmiSummary.total}</p>
              </div>
            </div>
          </div>
        </div>

        {/* PMI Table */}
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Asset
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    PMI Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Interval
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    WUC
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Next Due Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Days Until Due
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {pmiRecords.map((pmi) => {
                  const statusStyle = getPMIStatusStyle(pmi.status, pmi.days_until_due)

                  return (
                    <tr
                      key={pmi.pmi_id}
                      className={classNames(
                        'cursor-pointer transition-colors',
                        pmi.days_until_due < 0 ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'
                      )}
                      onClick={() => navigate(`/pmi/${pmi.pmi_id}`)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={classNames(
                          'px-2 py-1 text-xs font-medium rounded-full border',
                          statusStyle.bg,
                          statusStyle.text,
                          statusStyle.border
                        )}>
                          {statusStyle.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-gray-900">{pmi.asset_name}</div>
                          <div className="text-sm text-gray-500 font-mono">{pmi.asset_sn}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-900">{pmi.pmi_type}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                          {pmi.interval_days}-Day
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm font-mono text-gray-600">{pmi.wuc_cd}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-600">{formatDate(pmi.next_due_date)}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={classNames(
                          'text-sm font-medium',
                          pmi.days_until_due < 0 ? 'text-red-600' :
                          pmi.days_until_due <= 7 ? 'text-red-600' :
                          pmi.days_until_due <= 30 ? 'text-yellow-600' : 'text-green-600'
                        )}>
                          {pmi.days_until_due < 0
                            ? `${Math.abs(pmi.days_until_due)} day${Math.abs(pmi.days_until_due) !== 1 ? 's' : ''} overdue`
                            : `${pmi.days_until_due} day${pmi.days_until_due !== 1 ? 's' : ''}`
                          }
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Total count */}
          <div className="bg-white px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              {pmiRecords.length} PMI schedule entries
              {(debouncedPmiSearch || pmiIntervalFilter || pmiOverdueOnly) && (
                <span className="text-gray-400">
                  {' '}(filtered
                  {debouncedPmiSearch && ` by "${debouncedPmiSearch}"`}
                  {pmiIntervalFilter && ` by ${pmiIntervalFilter}-Day interval`}
                  {pmiOverdueOnly && ' to overdue only'}
                  )
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="bg-white rounded-lg shadow p-4">
          <h4 className="text-sm font-medium text-gray-700 mb-3">PMI Status Legend</h4>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-red-100 text-red-800 border-red-200">OVERDUE</span>
              <span className="text-xs text-gray-600">Past due date</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-red-100 text-red-800 border-red-200">DUE SOON</span>
              <span className="text-xs text-gray-600">Within 7 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-yellow-100 text-yellow-800 border-yellow-200">UPCOMING</span>
              <span className="text-xs text-gray-600">8-30 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-green-100 text-green-800 border-green-200">SCHEDULED</span>
              <span className="text-xs text-gray-600">More than 30 days</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  function renderTCTOTable() {
    if (tctoLoading) {
      return (
        <div className="bg-white shadow rounded-lg p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          </div>
        </div>
      )
    }

    if (tctoError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-600">{tctoError}</p>
          <button
            onClick={fetchTCTO}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )
    }

    if (tctoRecords.length === 0) {
      const hasActiveFilters = debouncedTctoSearch || tctoPriorityFilter || tctoStatusFilter
      return (
        <div className="space-y-6">
          {canCreateTCTO && !hasActiveFilters && (
            <div className="flex justify-end">
              <button
                onClick={openNewTCTOModal}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
              >
                <PlusIcon className="h-4 w-4" />
                Add TCTO
              </button>
            </div>
          )}
          <div className="bg-white shadow rounded-lg p-8 text-center">
            <ClockIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            {hasActiveFilters ? (
              <>
                <p className="text-gray-500 mb-4">No TCTO records match the current filters.</p>
                <button
                  onClick={() => {
                    setTctoSearch('')
                    setTctoPriorityFilter('')
                    setTctoStatusFilter('')
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 transition-colors"
                >
                  <XMarkIcon className="h-4 w-4" />
                  Clear All Filters
                </button>
              </>
            ) : (
              <>
                <p className="text-gray-500">No TCTO records found for the current program.</p>
                {canCreateTCTO && (
                  <button
                    onClick={openNewTCTOModal}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                  >
                    <PlusIcon className="h-4 w-4" />
                    Create First TCTO
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )
    }

    // TCTO status color helpers
    const getTCTODeadlineStyle = (daysUntilDeadline: number, status: string) => {
      if (status === 'closed') {
        return { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', label: 'COMPLETED' }
      }
      if (daysUntilDeadline < 0) {
        return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', label: 'OVERDUE' }
      }
      if (daysUntilDeadline <= 7) {
        return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', label: 'DUE SOON' }
      }
      if (daysUntilDeadline <= 30) {
        return { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', label: 'UPCOMING' }
      }
      return { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', label: 'ON TRACK' }
    }

    const getComplianceStyle = (percentage: number) => {
      if (percentage === 100) {
        return { bg: 'bg-green-100', text: 'text-green-800' }
      }
      if (percentage >= 50) {
        return { bg: 'bg-yellow-100', text: 'text-yellow-800' }
      }
      return { bg: 'bg-red-100', text: 'text-red-800' }
    }

    return (
      <div className="space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100">
                <ClockIcon className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{tctoSummary.open}</p>
                <p className="text-sm text-gray-500">Open TCTOs</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100">
                <ExclamationCircleIcon className="h-6 w-6 text-red-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{tctoSummary.overdue}</p>
                <p className="text-sm text-gray-500">Overdue</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-100">
                <ExclamationTriangleIcon className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{tctoSummary.critical}</p>
                <p className="text-sm text-gray-500">Critical</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100">
                <CheckCircleIcon className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{tctoSummary.closed}</p>
                <p className="text-sm text-gray-500">Completed</p>
              </div>
            </div>
          </div>
        </div>

        {/* Search and Filter Row */}
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search Input */}
            <div className="flex-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  value={tctoSearch}
                  onChange={(e) => setTctoSearch(e.target.value)}
                  placeholder="Search by TCTO number, title, or description..."
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm"
                />
              </div>
            </div>

            {/* Filter Buttons */}
            <div className="flex flex-wrap gap-2">
              {/* Priority Filter */}
              <button
                onClick={() => setTctoPriorityFilter(tctoPriorityFilter === 'Critical' ? '' : 'Critical')}
                className={classNames(
                  'flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                  tctoPriorityFilter === 'Critical'
                    ? 'bg-red-100 text-red-800 border-red-300'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                )}
              >
                <ExclamationCircleIcon className="h-4 w-4" />
                Critical
                {tctoPriorityFilter === 'Critical' && tctoSummary.critical > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-red-200 text-red-900">
                    {tctoRecords.filter(t => t.priority === 'Critical').length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setTctoPriorityFilter(tctoPriorityFilter === 'Urgent' ? '' : 'Urgent')}
                className={classNames(
                  'flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                  tctoPriorityFilter === 'Urgent'
                    ? 'bg-yellow-100 text-yellow-800 border-yellow-300'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                )}
              >
                <ExclamationTriangleIcon className="h-4 w-4" />
                Urgent
                {tctoPriorityFilter === 'Urgent' && tctoSummary.urgent > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-yellow-200 text-yellow-900">
                    {tctoRecords.filter(t => t.priority === 'Urgent').length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setTctoPriorityFilter(tctoPriorityFilter === 'Routine' ? '' : 'Routine')}
                className={classNames(
                  'flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                  tctoPriorityFilter === 'Routine'
                    ? 'bg-blue-100 text-blue-800 border-blue-300'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                )}
              >
                <ClockIcon className="h-4 w-4" />
                Routine
                {tctoPriorityFilter === 'Routine' && tctoSummary.routine > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-blue-200 text-blue-900">
                    {tctoRecords.filter(t => t.priority === 'Routine').length}
                  </span>
                )}
              </button>

              {/* Status Filter */}
              <button
                onClick={() => setTctoStatusFilter(tctoStatusFilter === 'open' ? '' : 'open')}
                className={classNames(
                  'flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                  tctoStatusFilter === 'open'
                    ? 'bg-orange-100 text-orange-800 border-orange-300'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                )}
              >
                Open Only
                {tctoStatusFilter === 'open' && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-orange-200 text-orange-900">
                    {tctoRecords.length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setTctoStatusFilter(tctoStatusFilter === 'closed' ? '' : 'closed')}
                className={classNames(
                  'flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                  tctoStatusFilter === 'closed'
                    ? 'bg-green-100 text-green-800 border-green-300'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                )}
              >
                Closed Only
                {tctoStatusFilter === 'closed' && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-green-200 text-green-900">
                    {tctoRecords.length}
                  </span>
                )}
              </button>

              {/* Clear All Filters Button */}
              {(tctoSearch || tctoPriorityFilter || tctoStatusFilter) && (
                <button
                  onClick={() => {
                    setTctoSearch('')
                    setTctoPriorityFilter('')
                    setTctoStatusFilter('')
                  }}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-300 rounded-lg hover:bg-red-100 transition-colors"
                >
                  <XMarkIcon className="h-4 w-4" />
                  Clear All
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Actions Row */}
        <div className="flex justify-end gap-2">
          {/* Export PDF Button */}
          <button
            onClick={exportTCTOToPdf}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            title="Export to PDF with CUI markings"
          >
            <DocumentArrowDownIcon className="h-4 w-4" />
            Export PDF
          </button>
          {/* Export Excel Button */}
          <button
            onClick={exportTCTOToExcel}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            title="Export to Excel with CUI markings"
          >
            <DocumentArrowDownIcon className="h-4 w-4" />
            Export Excel
          </button>
          <button
            onClick={fetchTCTO}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ArrowPathIcon className="h-4 w-4" />
            Refresh
          </button>
          {canCreateTCTO && (
            <button
              onClick={openNewTCTOModal}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
            >
              <PlusIcon className="h-4 w-4" />
              Add TCTO
            </button>
          )}
        </div>

        {/* TCTO Table */}
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    TCTO Number
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Title
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Priority
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Deadline
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Days Until
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Compliance
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  {(canEditTCTO || canDeleteTCTO) && (
                    <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {tctoRecords.map((tcto) => {
                  const deadlineStyle = getTCTODeadlineStyle(tcto.days_until_deadline, tcto.status)
                  const complianceStyle = getComplianceStyle(tcto.compliance_percentage)
                  return (
                    <tr
                      key={tcto.tcto_id}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => navigate(`/tcto/${tcto.tcto_id}`)}
                      title={`View TCTO ${tcto.tcto_no} details`}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-primary-600">{tcto.tcto_no}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900 max-w-xs truncate" title={tcto.title}>
                          {tcto.title}
                        </div>
                        <div className="text-xs text-gray-500 max-w-xs truncate" title={tcto.description}>
                          {tcto.description}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={classNames(
                          'px-2 py-1 text-xs font-medium rounded-full border',
                          priorityColors[tcto.priority]?.bg || 'bg-gray-100',
                          priorityColors[tcto.priority]?.text || 'text-gray-800',
                          priorityColors[tcto.priority]?.border || 'border-gray-200'
                        )}>
                          {tcto.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {new Date(tcto.compliance_deadline).toLocaleDateString()}
                        </div>
                        <div className="text-xs text-gray-500">
                          Effective: {new Date(tcto.effective_date).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className={classNames(
                          'text-sm font-medium',
                          tcto.days_until_deadline < 0 ? 'text-red-600' :
                          tcto.days_until_deadline <= 7 ? 'text-red-600' :
                          tcto.days_until_deadline <= 30 ? 'text-yellow-600' : 'text-green-600'
                        )}>
                          {tcto.status === 'closed' ? '-' :
                            tcto.days_until_deadline < 0
                              ? `${Math.abs(tcto.days_until_deadline)} days overdue`
                              : `${tcto.days_until_deadline} days`}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-200 rounded-full w-20 overflow-hidden">
                            <div
                              className={classNames(
                                'h-full rounded-full transition-all',
                                tcto.compliance_percentage === 100 ? 'bg-green-500' :
                                tcto.compliance_percentage >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                              )}
                              style={{ width: `${tcto.compliance_percentage}%` }}
                            />
                          </div>
                          <span className={classNames(
                            'text-xs font-medium',
                            complianceStyle.text
                          )}>
                            {tcto.compliance_percentage}%
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {tcto.compliant_assets.length}/{tcto.affected_assets.length} assets
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={classNames(
                          'px-2 py-1 text-xs font-medium rounded-full border',
                          deadlineStyle.bg,
                          deadlineStyle.text,
                          deadlineStyle.border
                        )}>
                          {deadlineStyle.label}
                        </span>
                      </td>
                      {(canEditTCTO || canDeleteTCTO) && (
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-2">
                            {canEditTCTO && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openEditTCTOModal(tcto, e); }}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-primary-600 hover:text-primary-800 hover:bg-primary-50 rounded-md transition-colors"
                                title={`Edit ${tcto.tcto_no}`}
                              >
                                <PencilIcon className="h-4 w-4" />
                                Edit
                              </button>
                            )}
                            {canDeleteTCTO && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openDeleteTCTOModal(tcto, e); }}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded-md transition-colors"
                                title={`Delete ${tcto.tcto_no}`}
                              >
                                <TrashIcon className="h-4 w-4" />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Count message */}
          <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
            <p className="text-sm text-gray-700">
              {tctoRecords.length} TCTO record{tctoRecords.length !== 1 ? 's' : ''}
              {(debouncedTctoSearch || tctoPriorityFilter || tctoStatusFilter) && (
                <span className="text-gray-500">
                  {' '}(filtered
                  {debouncedTctoSearch && ` by "${debouncedTctoSearch}"`}
                  {tctoPriorityFilter && ` by ${tctoPriorityFilter} priority`}
                  {tctoStatusFilter && ` by ${tctoStatusFilter} status`}
                  )
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="bg-white rounded-lg shadow p-4">
          <h4 className="text-sm font-medium text-gray-700 mb-3">TCTO Status Legend</h4>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-red-100 text-red-800 border-red-200">OVERDUE</span>
              <span className="text-xs text-gray-600">Past deadline</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-red-100 text-red-800 border-red-200">DUE SOON</span>
              <span className="text-xs text-gray-600">Within 7 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-yellow-100 text-yellow-800 border-yellow-200">UPCOMING</span>
              <span className="text-xs text-gray-600">8-30 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-green-100 text-green-800 border-green-200">ON TRACK</span>
              <span className="text-xs text-gray-600">More than 30 days</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 text-xs font-medium rounded-full border bg-green-100 text-green-800 border-green-200">COMPLETED</span>
              <span className="text-xs text-gray-600">All assets compliant</span>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
