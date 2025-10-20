import { FolderPlus, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface ActionCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
  onClick?: () => void;
}

function ActionCard({ icon, title, description, action, onClick }: ActionCardProps) {
  return (
    <Card
      className="p-6 flex flex-col items-center text-center gap-4 hover:elevation-3 transition-all duration-200 cursor-pointer group border-2 hover:border-primary/20"
      onClick={onClick}
    >
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary group-hover:scale-110 transition-transform duration-200">
        {icon}
      </div>
      <div className="space-y-2">
        <h3 className="text-heading font-semibold">{title}</h3>
        <p className="text-body-sm text-muted-foreground">{description}</p>
      </div>
      <div className="mt-2">{action}</div>
    </Card>
  );
}

interface WelcomeViewProps {
  onCreateWorkspace?: () => void;
  onAddRepository?: () => void;
  onCloneRepository?: () => void;
}

/**
 * WelcomeView - Dashboard welcome screen when no workspace is selected
 * Shows options to create workspace, add local repository, or clone from GitHub
 * Following design inspiration from Linear, Vercel, Stripe, Airbnb, Perplexity
 */
export function WelcomeView({
  onCreateWorkspace,
  onAddRepository,
  onCloneRepository,
}: WelcomeViewProps) {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="text-center mb-12 space-y-3">
        <h1 className="text-3xl font-bold text-foreground">Welcome to OpenDevs</h1>
        <p className="text-body text-muted-foreground max-w-2xl">
          Create a workspace or add a repository to get started
        </p>
      </div>

      {/* Action Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
        <ActionCard
          icon={<Plus className="w-8 h-8" />}
          title="Create Workspace"
          description="Create a new workspace from your repositories"
          action={
            <Button
              variant="default"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onCreateWorkspace?.();
              }}
            >
              New Workspace
            </Button>
          }
          onClick={onCreateWorkspace}
        />

        <ActionCard
          icon={<FolderPlus className="w-8 h-8" />}
          title="Add Repository"
          description="Add an existing repository from your local machine"
          action={
            <Button
              variant="default"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onAddRepository?.();
              }}
            >
              Add Local
            </Button>
          }
          onClick={onAddRepository}
        />

        <ActionCard
          icon={<Github className="w-8 h-8" />}
          title="Clone Repository"
          description="Clone a repository from GitHub"
          action={
            <Button
              variant="default"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onCloneRepository?.();
              }}
            >
              Clone from GitHub
            </Button>
          }
          onClick={onCloneRepository}
        />
      </div>
    </div>
  );
}
