// The single hydration channel: server state serialized into one
// <script id="bootstrap"> that app.js reads on DOMContentLoaded.
// "< is escaped so a payload containing "</script>" cannot break out.
export function BootstrapScript(props: { data: unknown }) {
  return (
    <script
      type="application/json"
      id="bootstrap"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(props.data).replace(/</g, '\\u003c'),
      }}
    />
  )
}
