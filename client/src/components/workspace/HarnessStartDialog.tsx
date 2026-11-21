import { ChevronRight, FolderOpen, MessageSquare, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { Surface } from '@/components/ui/surface.js';

type Location = { id: string; projectName: string; computerName: string };
type OccupiedComputer = { id: string; title: string; computerName: string };

export function HarnessStartDialog({ open, onOpenChange, harnessName, locations, value, onSelect, onChooseProject, onStart, occupied = [], onResume, loading, starting, error, unavailable }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  harnessName: string;
  locations: Location[];
  value: string;
  onSelect: (id: string) => void;
  onChooseProject: () => void;
  onStart: () => void;
  occupied?: OccupiedComputer[];
  onResume?: (id: string) => void;
  loading?: boolean;
  starting?: boolean;
  error?: string | null;
  unavailable?: string;
}) {
  const { t } = useTranslation('workspace');
  const description = !locations.length && occupied.length ? 'harness.computersBusy'
    : 'harness.selectDescription';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild><Button type="button" className="min-h-11"><Plus />{t('harness.new')}</Button></DialogTrigger>
    <DialogContent showCloseButton={false} className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('harness.new')}</DialogTitle>
        <DialogDescription>{unavailable ?? t(description, { harness: harnessName })}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
        {locations.length > 0 && <ChoiceList label={t('harness.project')} value={value} onChange={onSelect} disabled={starting}
          options={locations.map((location) => ({
            id: location.id, label: location.projectName, description: location.computerName, icon: <FolderOpen className="size-4" />,
          }))} />}
        <Button type="button" variant="outline" className="min-h-11" disabled={starting} onClick={onChooseProject}>
          <FolderOpen />{t('harness.chooseProject')}
        </Button>
        {occupied.length > 0 && onResume && <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t('harness.resumeExisting')}</h3>
          <Surface tone="sheet" className="workspace-rows">
            {occupied.map((session) => <Button key={session.id} type="button" variant="row" size="bare" disabled={starting}
              className="workspace-row flex min-h-11 items-center gap-3 px-2 py-2 text-left" onClick={() => onResume(session.id)}>
              <MessageSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block text-sm font-medium">{session.title}</span>
                <span className="block text-xs text-muted-foreground">{session.computerName}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </Button>)}
          </Surface>
        </div>}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p>
          : loading && <p role="status" className="text-sm text-muted-foreground">{t('harness.loading')}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" disabled={starting} onClick={() => onOpenChange(false)}>{t('settings:actions.cancel')}</Button>
          {locations.length > 0 && <Button type="submit" className="min-h-11" disabled={!value || starting}>
            {t(starting ? 'harness.status.creating' : 'harness.start', { harness: harnessName })}
          </Button>}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
