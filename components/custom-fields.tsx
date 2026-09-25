"use client";

import { Input } from "@/components/ui/input";

export type CustomFieldDefinition = {
  id: number;
  entityType: string;
  name: string;
  fieldKey: string;
  fieldType: string;
  options: string[];
};

export type CustomFieldValue = {
  definitionId: number;
  entityType: string;
  entityId: number;
  value: string;
};

const customFieldInputName = (id: number) => `customField_${id}`;

export function CustomFieldInput({ field, value = "" }: { field: CustomFieldDefinition; value?: string }) {
  const name = customFieldInputName(field.id);
  const className = "h-10 min-w-0 w-full rounded-md border bg-white px-3 text-sm";
  return <label className="grid gap-1 text-sm font-medium">
    {field.name}
    {field.fieldType === "select" ? <select name={name} defaultValue={value} className={className}>
      <option value="">Not set</option>
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select> : field.fieldType === "boolean" ? <select name={name} defaultValue={value} className={className}>
      <option value="">Not set</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select> : <Input name={name} type={field.fieldType === "number" || field.fieldType === "date" ? field.fieldType : "text"} defaultValue={value}/>} 
  </label>;
}

export function customFieldValue(values: CustomFieldValue[], entityType: string, entityId: number, definitionId: number) {
  return values.find(value => value.entityType === entityType && value.entityId === entityId && value.definitionId === definitionId)?.value || "";
}
