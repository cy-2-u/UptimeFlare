import { pageConfig } from '@/uptime.config'

export default function Footer() {
  const links = pageConfig.links || []

  return (
    <footer className="mt-14 border-t border-slate-200/70 py-8 text-sm text-slate-500">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p>
          &copy; {new Date().getFullYear()} {pageConfig.title || '服务状态'} · 每 10 分钟自动检查
        </p>
        <div className="flex flex-wrap items-center gap-4">
          {links.map((link) => (
            <a
              key={link.link}
              href={link.link}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-slate-950"
            >
              {link.label}
            </a>
          ))}
          {pageConfig.customFooter && (
            <div dangerouslySetInnerHTML={{ __html: pageConfig.customFooter }} className="text-xs opacity-70" />
          )}
        </div>
      </div>
    </footer>
  )
}
