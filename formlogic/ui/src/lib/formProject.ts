import { createFormlogicProject, type FormlogicProjectInput } from './softn/project';

/** Give exports the workspace workflow even when the installed adapter predates ZIP downloads. */
export function createFormProject(input: FormlogicProjectInput) {
  const project = createFormlogicProject(input);
  project.files['README.md'] = [
    `# ${input.app.name}`,
    'In FormLogic, open Apps → Create app → Upload ZIP and choose this ZIP. Open Edit to customise the project in Builder or Studio.',
    '## Form screens',
    'Each form has a screen in ui/forms/ and field definitions in logic/forms/. The main screen links them together. formlogic.modules.json lists each module, its collection and its source form.',
    'To reuse a module, copy its UI and logic files, add both paths to manifest.json, then import the component and its collection in the main screen. Exporting your forms again creates a fresh copy.',
    '## Data and access',
    'Records entered in these screens stay on the device. This project contains the selected form definitions. Existing responses, credentials, automations and access grants are excluded. To share data, configure a private backend with its own permissions in FormLogic.',
    '## Conversion notes',
    project.warnings.length ? project.warnings.map(note => '- ' + note).join('\n') : 'Review the generated screens, validation and access before publishing.',
  ].join('\n\n') + '\n';
  return project;
}
