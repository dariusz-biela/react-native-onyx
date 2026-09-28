import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';
import {reportSummariesSelector} from '@app/selectors';

import {countRender} from '../../harness/renderCount';

/** One hook on the whole report collection through the module-level `reportSummariesSelector`. */
function ReportSummariesProbe() {
    countRender();
    useOnyx(ONYXKEYS.COLLECTION.REPORT, {selector: reportSummariesSelector});
    return null;
}

export default ReportSummariesProbe;
