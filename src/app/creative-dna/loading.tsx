export default function Loading() {
  return (
    <div className="min-h-screen px-8 pt-6 animate-pulse">
      <div className="h-8 w-48 bg-gray-200 rounded mb-6" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="lv-card p-4 h-48 bg-gray-50" />
        ))}
      </div>
    </div>
  );
}
