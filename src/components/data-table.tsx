import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import type { Row } from "@/domain/models";

export function DataTable({
  rows,
  empty = "No rows to display.",
}: {
  rows: readonly Row[];
  empty?: string;
}) {
  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      Object.keys(rows[0] || {}).map((key) => ({
        accessorKey: key,
        header: key,
        cell: (info) => {
          const value = info.getValue();
          return value === null ? (
            <span className="null-value">null</span>
          ) : (
            <span title={String(value)}>{String(value)}</span>
          );
        },
      })),
    [rows],
  );
  const table = useReactTable({ data: rows as Row[], columns, getCoreRowModel: getCoreRowModel() });
  if (!rows.length) return <div className="empty-small">{empty}</div>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
