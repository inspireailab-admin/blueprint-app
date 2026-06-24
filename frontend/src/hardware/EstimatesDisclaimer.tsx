import { gpusAsOf, cloudAsOf } from '../planner/hardware-catalog'

type Props = {
  /** The catalog's "as of" date, plumbed in from the IPC load. */
  catalogAsOf: string
}

export function EstimatesDisclaimer({ catalogAsOf }: Props) {
  return (
    <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
      <b className="font-mono text-foreground">Estimates only.</b>{' '}
      Models as of {catalogAsOf} · GPUs as of {gpusAsOf} · cloud pricing as of {cloudAsOf}.
      Real per-region pricing varies 30%+; on a live engagement we pull current data
      from each provider before any commitment.
    </p>
  )
}
