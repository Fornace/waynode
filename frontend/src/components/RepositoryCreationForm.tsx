interface RepositoryCreationFormProps {
  provider: "github" | "gitlab";
  name: string;
  description: string;
  visibility: "private" | "public";
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onVisibility: (value: "private" | "public") => void;
  onSubmit: () => Promise<void>;
}

export function RepositoryCreationForm(props: RepositoryCreationFormProps) {
  return (
    <form className="repo-create-form" onSubmit={(event) => { event.preventDefault(); void props.onSubmit(); }}>
      <div className="form-field">
        <label className="form-label" htmlFor="new-repo-name">{props.provider === "github" ? "Repository" : "Project"} name</label>
        <input id="new-repo-name" className="form-input" value={props.name} onChange={(event) => props.onName(event.target.value)} autoComplete="off" maxLength={100} />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="new-repo-description">Description <small>Optional</small></label>
        <input id="new-repo-description" className="form-input" value={props.description} onChange={(event) => props.onDescription(event.target.value)} maxLength={350} />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="new-repo-visibility">Visibility</label>
        <select id="new-repo-visibility" className="form-input" value={props.visibility} onChange={(event) => props.onVisibility(event.target.value as "private" | "public")}>
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select>
      </div>
      <button type="submit" className="repo-url-clone-btn" disabled={!props.name.trim() || props.busy}>
        {props.busy ? "Creating and cloning…" : "Create and clone"}
      </button>
    </form>
  );
}
