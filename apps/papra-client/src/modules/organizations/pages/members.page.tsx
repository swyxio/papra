import type { Component } from 'solid-js';
import type { OrganizationMemberRole } from '../organizations.types';
import { useParams } from '@solidjs/router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import {
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
} from '@tanstack/solid-table';
import { For } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { queryClient } from '@/modules/shared/query/query-client';
import { Button } from '@/modules/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';
import { createToast } from '@/modules/ui/components/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/modules/ui/components/table';
import { useCurrentUserRole } from '../organizations.composables';
import { ORGANIZATION_ROLES } from '../organizations.constants';
import { getIsMemberRoleDisabled } from '../organizations.models';
import { fetchOrganizationMembers, updateOrganizationMemberRole } from '../organizations.services';

const MemberList: Component = () => {
  const params = useParams();
  const { t } = useI18n();
  const query = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'members'],
    queryFn: async () => fetchOrganizationMembers({ organizationId: params.organizationId }),
  }));
  const { getErrorMessage } = useI18nApiErrors({ t });

  const { getRole } = useCurrentUserRole({
    organizationId: params.organizationId,
  });

  const updateMemberRoleMutation = useMutation(() => ({
    mutationFn: async ({ memberId, role }: { memberId: string; role: OrganizationMemberRole }) =>
      updateOrganizationMemberRole({ organizationId: params.organizationId, memberId, role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['organizations', params.organizationId, 'members'],
      });

      createToast({
        message: t('organizations.members.update-role.success'),
      });
    },
    onError: (error) => {
      createToast({
        message: getErrorMessage({ error }),
        type: 'error',
      });
    },
  }));

  const handleUpdateMemberRole = async ({
    memberId,
    role,
  }: {
    memberId: string;
    role: OrganizationMemberRole;
  }) => {
    await updateMemberRoleMutation.mutateAsync({ memberId, role });
  };

  const table = createSolidTable({
    get data() {
      return query.data?.members ?? [];
    },
    columns: [
      { header: t('organizations.members.table.headers.name'), accessorKey: 'user.name' },
      { header: t('organizations.members.table.headers.email'), accessorKey: 'user.email' },
      {
        header: t('organizations.members.table.headers.role'),
        accessorKey: 'role',
        cell: (data) => t(`organizations.members.roles.${data.getValue<OrganizationMemberRole>()}`),
      },
      {
        header: t('organizations.members.table.headers.actions'),
        id: 'actions',
        cell: (data) => (
          <div class="flex items-center justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger as={Button} variant="ghost" size="icon">
                <div class="i-tabler-dots-vertical size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel class="font-normal">
                    {t('organizations.members.role')}
                  </DropdownMenuGroupLabel>
                  <DropdownMenuRadioGroup
                    value={data.row.original.role}
                    onChange={async (role) =>
                      handleUpdateMemberRole({
                        memberId: data.row.original.id,
                        role: role as OrganizationMemberRole,
                      })
                    }
                  >
                    <DropdownMenuRadioItem
                      value={ORGANIZATION_ROLES.OWNER}
                      disabled={getIsMemberRoleDisabled({
                        currentUserRole: getRole(),
                        memberRole: data.row.original.role,
                        targetRole: ORGANIZATION_ROLES.OWNER,
                      })}
                    >
                      {t(`organizations.members.roles.owner`)}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem
                      value={ORGANIZATION_ROLES.ADMIN}
                      disabled={getIsMemberRoleDisabled({
                        currentUserRole: getRole(),
                        memberRole: data.row.original.role,
                        targetRole: ORGANIZATION_ROLES.ADMIN,
                      })}
                    >
                      {t(`organizations.members.roles.admin`)}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem
                      value={ORGANIZATION_ROLES.MEMBER}
                      disabled={getIsMemberRoleDisabled({
                        currentUserRole: getRole(),
                        memberRole: data.row.original.role,
                        targetRole: ORGANIZATION_ROLES.MEMBER,
                      })}
                    >
                      {t(`organizations.members.roles.member`)}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <div>
      <Table>
        <TableHeader>
          <For each={table.getHeaderGroups()}>
            {(headerGroup) => (
              <TableRow>
                <For each={headerGroup.headers}>
                  {(header) => (
                    <TableHead>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )}
                </For>
              </TableRow>
            )}
          </For>
        </TableHeader>
        <TableBody>
          <For each={table.getRowModel().rows}>
            {(row) => (
              <TableRow>
                <For each={row.getVisibleCells()}>
                  {(cell) => (
                    <TableCell>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )}
                </For>
              </TableRow>
            )}
          </For>
        </TableBody>
      </Table>
    </div>
  );
};
export const MembersPage: Component = () => {
  const { t } = useI18n();
  return (
    <div class="p-6 max-w-screen-md mx-auto mt-4">
      <div class="border-b mb-6 pb-4">
        <h1 class="text-xl font-bold">{t('organizations.members.title')}</h1>
        <p class="text-sm text-muted-foreground">
          Membership is assigned automatically from verified Google accounts. Personal spaces stay
          private.
        </p>
      </div>
      <MemberList />
    </div>
  );
};
