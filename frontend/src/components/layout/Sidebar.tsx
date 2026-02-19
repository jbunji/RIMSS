import { Fragment } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { NavLink } from 'react-router-dom'
import {
  XMarkIcon,
  HomeIcon,
  CubeIcon,
  Cog6ToothIcon,
  WrenchScrewdriverIcon,
  PaperAirplaneIcon,
  ArchiveBoxIcon,
  TruckIcon,
  BellIcon,
  DocumentChartBarIcon,
  UsersIcon,
  CodeBracketIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'
import { useAuthStore } from '../../stores/authStore'

// Navigation items based on app_spec.txt
const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
  { name: 'Assets', href: '/assets', icon: CubeIcon },
  { name: 'Configurations', href: '/configurations', icon: Cog6ToothIcon },
  { name: 'Maintenance', href: '/maintenance', icon: WrenchScrewdriverIcon },
  { name: 'Sorties', href: '/sorties', icon: PaperAirplaneIcon },
  { name: 'Spares', href: '/spares', icon: ArchiveBoxIcon },
  { name: 'Parts Ordered', href: '/parts-ordered', icon: TruckIcon },
  { name: 'Software', href: '/software', icon: CodeBracketIcon },
  { name: 'Notifications', href: '/notifications', icon: BellIcon },
  { name: 'Reports', href: '/reports', icon: DocumentChartBarIcon },
]

// Admin-only navigation items
const adminNavigation = [
  { name: 'Admin', href: '/admin', icon: ShieldCheckIcon },
  { name: 'Users', href: '/admin/users', icon: UsersIcon },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'ADMIN'
  const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center px-3 py-3 min-h-[44px] text-sm font-medium rounded-md transition-all duration-200 ease-in-out ${
      isActive
        ? 'bg-primary-100 text-primary-800 shadow-sm'
        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900 hover:shadow-sm hover:-translate-y-0.5'
    }`

  const iconClasses = (isActive: boolean) =>
    `mr-3 h-5 w-5 flex-shrink-0 transition-all duration-200 ease-in-out ${
      isActive
        ? 'text-primary-600 scale-110'
        : 'text-gray-400 group-hover:text-gray-500 group-hover:scale-110'
    }`

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo area for mobile */}
      <div className="flex items-center h-16 px-4 border-b border-gray-200 lg:hidden">
        <span className="text-primary-800 font-bold text-xl">ACSS</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="space-y-1">
          {navigation.map((item) => (
            <NavLink
              key={item.name}
              to={item.href}
              className={navLinkClasses}
              onClick={onClose}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={iconClasses(isActive)} aria-hidden="true" />
                  {item.name}
                </>
              )}
            </NavLink>
          ))}
        </div>

        {/* Admin section */}
        {isAdmin && (
          <div className="pt-4 mt-4 border-t border-gray-200">
            <p className="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Administration
            </p>
            {adminNavigation.map((item) => (
              <NavLink
                key={item.name}
                to={item.href}
                className={navLinkClasses}
                onClick={onClose}
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={iconClasses(isActive)} aria-hidden="true" />
                    {item.name}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        )}
      </nav>

      {/* Version info */}
      <div className="px-4 py-3 border-t border-gray-200">
        <p className="text-xs text-gray-500">ACSS v1.0</p>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile sidebar */}
      <Transition.Root show={open} as={Fragment}>
        <Dialog as="div" className="relative z-50 lg:hidden" onClose={onClose}>
          <Transition.Child
            as={Fragment}
            enter="transition-opacity ease-linear duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-linear duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-600 bg-opacity-75" />
          </Transition.Child>

          <div className="fixed inset-0 z-50 flex">
            <Transition.Child
              as={Fragment}
              enter="transition ease-in-out duration-300 transform"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition ease-in-out duration-300 transform"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <Dialog.Panel className="relative flex w-full max-w-xs flex-1 flex-col bg-white">
                <Transition.Child
                  as={Fragment}
                  enter="ease-in-out duration-300"
                  enterFrom="opacity-0"
                  enterTo="opacity-100"
                  leave="ease-in-out duration-300"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <div className="absolute top-0 right-0 -mr-12 pt-2">
                    <button
                      type="button"
                      className="ml-1 flex h-10 w-10 items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white"
                      onClick={onClose}
                    >
                      <span className="sr-only">Close sidebar</span>
                      <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
                    </button>
                  </div>
                </Transition.Child>
                <SidebarContent />
              </Dialog.Panel>
            </Transition.Child>
            <div className="w-14 flex-shrink-0" aria-hidden="true">
              {/* Dummy element to force sidebar to shrink to fit close icon */}
            </div>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:z-40 lg:flex lg:w-64 lg:flex-col">
        {/* Sidebar component for desktop - pt-[calc(1.75rem+4rem)] accounts for fixed CUI banner (1.75rem) + navbar height (4rem) */}
        <div className="flex min-h-0 flex-1 flex-col bg-white border-r border-gray-200 pt-[calc(1.75rem+4rem)]">
          <SidebarContent />
        </div>
      </div>
    </>
  )
}
