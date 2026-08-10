interface Props {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}

export default function Slider({ label, value, min, max, step, format, onChange }: Props) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className="text-xs tabular-nums text-neutral-500">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-indigo-500"
      />
    </label>
  )
}
